import {
  KubernetesProvider,
  IngressTlsCertificate,
  TlsManagerConfig,
  LEServerType,
  KubernetesPluginContext,
} from "../config"
import { KubeApi } from "../api"
import { getAppNamespace, ensureNamespace } from "../namespace"
import { sleep } from "../../../util/util"
import { find } from "lodash"
import { LogEntry } from "../../../logger/log-entry"
import { KUBECTL_DEFAULT_TIMEOUT, apply, kubectl } from "../kubectl"
import { PluginContext } from "../../../plugin-context"
import { join } from "path"
import { STATIC_DIR } from "../../../constants"
import { readFile } from "fs-extra"
import yaml from "js-yaml"
import { checkResourceStatuses } from "../status/status"
import { KubernetesServerResource } from "../types"
import { V1Pod } from "@kubernetes/client-node"
import { ServiceState } from "../../../types/service"
import { EnvironmentStatus } from "../../../types/plugin/provider/getEnvironmentStatus"
import { PrimitiveMap } from "../../../config/common"
import chalk from "chalk"

export interface GetIssuerParams {
  name: string
  namespace: string
  tlsManager: TlsManagerConfig
  tlsCertificate: IngressTlsCertificate
  serverType: LEServerType
}

export function getIssuerFromTls({ name, tlsManager, tlsCertificate, serverType }: GetIssuerParams) {

  let server = "https://acme-staging-v02.api.letsencrypt.org/directory"
  if (serverType === "prod") {
    server = "https://acme-v02.api.letsencrypt.org/directory"
  }

  return {
    apiVersion: "cert-manager.io/v1alpha2",
    kind: "ClusterIssuer",
    metadata: {
      name,
    },
    spec: {
      acme: {
        server,
        email: tlsManager.email,
        privateKeySecretRef: {
          name: tlsCertificate.secretRef.name,
        },
        solvers: [
          {
            http01: {
              ingress: {
                class: "nginx",
              },
            },
          },
        ],
      },
    },
  }
}

export interface GetCertificateParams {
  namespace: string
  tlsManager: TlsManagerConfig
  tlsCertificate: IngressTlsCertificate
  issuerName: string
}
export function getCertificateFromTls({
  tlsManager,
  tlsCertificate,
  issuerName,
}: GetCertificateParams) {

  const hostnames = tlsCertificate.hostnames || []
  return {
    apiVersion: "cert-manager.io/v1alpha2",
    kind: "Certificate",
    metadata: {
      name: getCertificateName({ tlsCertificate, tlsManager }),
    },
    spec: {
      secretName: tlsCertificate.secretRef.name,
      issuerRef: {
        name: issuerName,
        kind: "ClusterIssuer",
      },
      commonName: hostnames[0],
      dnsNames: hostnames,
    },
  }
}

export function getCertificateName({ tlsCertificate, tlsManager }) {
  const serverType = tlsManager.serverType || "staging"
  return `${tlsCertificate.name}-certificate-${serverType}`
}

export async function checkCertificateStatusByName({ ctx, log, provider, resources = [], namespace }: PredicateParams) {
  const ns = namespace || await getAppNamespace(ctx, log, provider)
  const existingCertificates = await getAllCertificates(log, provider, ns)
  return resources.every(
    el => find(existingCertificates.items, (o) => o.metadata.name === el && isCertificateReady(o)))
}

export async function checkForCertManagerPodsReady({ log, provider }: PredicateParams) {
  return await checkCertManagerStatus({ provider, log }) === "ready"
}

interface PredicateParams {
  ctx: PluginContext
  provider: KubernetesProvider
  log: LogEntry
  namespace?: string
  resources?: any[]
}
interface WaitForResourcesParams {
  ctx: PluginContext,
  provider: KubernetesProvider,
  log: LogEntry,
  resourcesType: string
  resources: any[]
  predicate: (PredicateParams) => Promise<boolean>
}

export async function waitForResourcesWith({
  ctx,
  provider,
  log,
  resourcesType,
  resources,
  predicate }: WaitForResourcesParams) {
  let loops = 0
  const startTime = new Date().getTime()

  const statusLine = log.info({
    symbol: "info",
    section: resourcesType,
    msg: `Waiting for resources to be ready...`,
  })

  const namespace = await getAppNamespace(ctx, log, provider)

  while (true) {
    await sleep(2000 + 500 * loops)
    loops += 1

    if (await predicate({ ctx, provider, log, resources, namespace })) {
      break
    }

    const now = new Date().getTime()

    if (now - startTime > KUBECTL_DEFAULT_TIMEOUT * 1000) {
      throw new Error(`Timed out waiting for ${resourcesType} to be ready`)
    }
  }

  statusLine.setState({ symbol: "info", section: resourcesType, msg: `Resources ready` })

}

export function isCertificateReady(cert) {
  const { conditions } = cert.status
  return conditions
    && conditions[0]
    && conditions[0].status === "True"
    && conditions[0].type === "Ready"
}

export async function getAllCertificates(log: LogEntry, provider: KubernetesProvider, namespace: string) {
  const args = [
    "get", "certificates", "--namespace", namespace,
  ]
  return kubectl.json({ log, provider, args })
}

// This is the suggested way to check if cert-maanger got deployed succesfully
// https://docs.cert-manager.io/en/latest/getting-started/install/kubernetes.html
export async function checkCertManagerStatus({ provider, log, namespace = "cert-manager" }): Promise<ServiceState> {
  const api = await KubeApi.factory(log, provider)
  const systemPods = await api.core.listNamespacedPod(namespace)
  const certManagerPods: KubernetesServerResource<V1Pod>[] = []
  systemPods.items
    .filter(pod => pod.metadata.name.includes("cert-manager"))
    .map(pod => {
      pod.apiVersion = "v1"
      pod.kind = "Pod"
      certManagerPods.push(pod)
    })

  // Expect to find 3 pods running:
  // cert-manager, cert-manager-cainjector and cert-manager-webhook
  if (certManagerPods.length !== 3) {
    return "missing"
  }
  const podsStatuses = await checkResourceStatuses(api, namespace, certManagerPods, log)
  const notReady = podsStatuses.filter(p => p.state !== "ready")

  return notReady.length ? notReady[0].state : "ready"
}

export interface SetupCertManagerParams {
  ctx: KubernetesPluginContext
  provider: KubernetesProvider
  log: LogEntry
  status: EnvironmentStatus<PrimitiveMap>
}

export async function setupCertManager({ ctx, provider, log, status }: SetupCertManagerParams) {

  const entry = log.info({
    section: "cert-manager",
    msg: `Installing to cert-manager namespace...`,
    status: "active",
  })

  if (!status.detail.systemCertManagerReady) {
    const api = await KubeApi.factory(log, provider)
    await ensureNamespace(api, "cert-manager")
    const customResourcesPath = join(STATIC_DIR, "kubernetes", "system", "cert-manager", "cert-manager-crd.yaml")
    const crd = await yaml.safeLoadAll((await readFile(customResourcesPath)).toString()).filter(x => x)
    entry.setState("Installing Custom Resources...")
    await apply({ log, provider, manifests: crd, validate: false })

    const waitForCertManagerPods: WaitForResourcesParams = {
      ctx,
      provider,
      log,
      resources: [],
      resourcesType: "cert-manager pods",
      predicate: checkForCertManagerPodsReady,
    }
    await waitForResourcesWith(waitForCertManagerPods)
    entry.setState("Custom Resources installed.")
  }

  if (!status.detail.systemManagedCertificatesReady && !provider.config.tlsManager!.installOnly) {
    entry.setState("Creating Issuers...")
    const issuers: any[] = []
    const certificates: any[] = []
    const secretNames: string[] = []
    const namespace = provider.config.namespace || ctx.projectName
    provider.config.tlsCertificates
      .filter(cert => cert.managedBy === "cert-manager")
      .map(cert => {
        const tlsManager = provider.config.tlsManager
        if (tlsManager) {

          const serverType = cert.serverType || "staging"
          const issuerName = `${cert.name}-${serverType}`

          const issuerManifest = getIssuerFromTls({
            name: issuerName,
            namespace,
            tlsManager,
            tlsCertificate: cert,
            serverType,
          })
          issuers.push(issuerManifest)

          const certManifest = getCertificateFromTls({ namespace, tlsManager, tlsCertificate: cert, issuerName })
          certificates.push(certManifest)

          secretNames.push(cert.secretRef.name)
        }
      })

    await apply({ log, provider, manifests: issuers })
    entry.setState("Issuers created.")

    await apply({ log, provider, manifests: certificates, namespace })
    entry.setState("Creating certificates...")

    const certificateNames = certificates.map(cert => cert.metadata.name)
    const waitForCertificatesParams: WaitForResourcesParams = {
      ctx,
      provider,
      log,
      resources: certificateNames,
      resourcesType: "Certificates",
      predicate: checkCertificateStatusByName,
    }
    await waitForResourcesWith(waitForCertificatesParams)

    entry.setState("Certificates created and \"Ready\"")

  }

  entry.setSuccess({ msg: chalk.green(`Done (took ${entry.getDuration(1)} sec)`), append: true })
}
