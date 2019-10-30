/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import Bluebird from "bluebird"

import { createGardenPlugin } from "../../types/plugin/plugin"
import { helmHandlers } from "./helm/handlers"
import { getAppNamespace, getMetadataNamespace } from "./namespace"
import { getSecret, setSecret, deleteSecret } from "./secrets"
import { getEnvironmentStatus, prepareEnvironment, cleanupEnvironment } from "./init"
import { containerHandlers } from "./container/handlers"
import { kubernetesHandlers } from "./kubernetes-module/handlers"
import { ConfigureProviderParams } from "../../types/plugin/provider/configureProvider"
import { DebugInfo, GetDebugInfoParams } from "../../types/plugin/provider/getDebugInfo"
import { systemNamespace, systemMetadataNamespace } from "./system"
import { kubectl } from "./kubectl"
import { KubernetesConfig, KubernetesPluginContext } from "./config"
import { configSchema } from "./config"
import { ConfigurationError } from "../../exceptions"
import { cleanupClusterRegistry } from "./commands/cleanup-cluster-registry"
import { clusterInit } from "./commands/cluster-init"
import { uninstallGardenServices } from "./commands/uninstall-garden-services"
import chalk from "chalk"
import { joi, joiIdentifier } from "../../config/common"
import { resolve } from "path"
import { dedent } from "../../util/string"
import { kubernetesModuleSpecSchema } from "./kubernetes-module/config"
import { helmModuleSpecSchema, helmModuleOutputsSchema } from "./helm/config"

export async function configureProvider({
  projectName,
  projectRoot,
  config,
}: ConfigureProviderParams<KubernetesConfig>) {
  config._systemServices = []

  if (!config.namespace) {
    config.namespace = projectName
  }

  if (config.setupIngressController === "nginx") {
    config._systemServices.push("ingress-controller", "default-backend")
  }

  if (config.buildMode === "cluster-docker" || config.buildMode === "kaniko") {
    // TODO: support external registry
    // This is a special configuration, used in combination with the registry-proxy service,
    // to make sure every node in the cluster can resolve the image from the registry we deploy in-cluster.
    config.deploymentRegistry = {
      hostname: `127.0.0.1:5000`,
      namespace: config.namespace,
    }

    // Deploy build services on init
    config._systemServices.push("build-sync", "docker-registry", "registry-proxy")

    if (config.buildMode === "cluster-docker") {
      config._systemServices.push("docker-daemon")
    }

    // Set up an NFS provisioner if the user doesn't explicitly set a storage class for the shared sync volume
    if (!config.storage.sync.storageClass) {
      config._systemServices.push("nfs-provisioner")
    }
  } else if (config.name !== "local-kubernetes" && !config.deploymentRegistry) {
    throw new ConfigurationError(`kubernetes: must specify deploymentRegistry in config if using local build mode`, {
      config,
    })
  }

  if (config.kubeconfig) {
    config.kubeconfig = resolve(projectRoot, config.kubeconfig)
  }

  return { config }
}

export async function debugInfo({ ctx, log, includeProject }: GetDebugInfoParams): Promise<DebugInfo> {
  const k8sCtx = <KubernetesPluginContext>ctx
  const provider = k8sCtx.provider
  const entry = log.info({ section: ctx.provider.name, msg: "collecting provider configuration", status: "active" })
  const namespacesList = [systemNamespace, systemMetadataNamespace]
  if (includeProject) {
    const appNamespace = await getAppNamespace(k8sCtx, log, k8sCtx.provider)
    const appMetadataNamespace = await getMetadataNamespace(k8sCtx, log, k8sCtx.provider)
    namespacesList.push(appNamespace, appMetadataNamespace)
  }
  const namespaces = await Bluebird.map(namespacesList, async (ns) => {
    const nsEntry = entry.info({ section: ns, msg: "collecting namespace configuration", status: "active" })
    const out = await kubectl.stdout({ log, provider, args: ["get", "all", "--namespace", ns, "--output", "json"] })
    nsEntry.setSuccess({ msg: chalk.green(`Done (took ${log.getDuration(1)} sec)`), append: true })
    return {
      namespace: ns,
      output: JSON.parse(out),
    }
  })
  entry.setSuccess({ msg: chalk.green(`Done (took ${log.getDuration(1)} sec)`), append: true })

  const version = await kubectl.stdout({ log, provider, args: ["version", "--output", "json"] })

  return {
    info: { version: JSON.parse(version), namespaces },
  }
}

const outputsSchema = joi.object().keys({
  "app-namespace": joiIdentifier()
    .required()
    .description("The primary namespace used for resource deployments."),
  "default-hostname": joi.string().description("The default hostname configured on the provider."),
  "metadata-namespace": joiIdentifier()
    .required()
    .description("The namespace used for Garden metadata."),
})

export const gardenPlugin = createGardenPlugin({
  name: "kubernetes",
  dependencies: ["container"],
  configSchema,
  outputsSchema,
  commands: [cleanupClusterRegistry, clusterInit, uninstallGardenServices],
  handlers: {
    configureProvider,
    getEnvironmentStatus,
    prepareEnvironment,
    cleanupEnvironment,
    getSecret,
    setSecret,
    deleteSecret,
    getDebugInfo: debugInfo,
  },
  createModuleTypes: [
    {
      name: "helm",
      docs: dedent`
        Specify a Helm chart (either in your repository or remote from a registry) to deploy.
        Refer to the [Helm guide](https://docs.garden.io/using-garden/using-helm-charts) for usage instructions.
      `,
      moduleOutputsSchema: helmModuleOutputsSchema,
      schema: helmModuleSpecSchema,
      handlers: helmHandlers,
    },
    {
      name: "kubernetes",
      docs: dedent`
        Specify one or more Kubernetes manifests to deploy.

        You can either (or both) specify the manifests as part of the \`garden.yml\` configuration, or you can refer to
        one or more files with existing manifests.

        Note that if you include the manifests in the \`garden.yml\` file, you can use
        [template strings](https://docs.garden.io/reference/template-strings) to interpolate values into the manifests.

        If you need more advanced templating features you can use the
        [helm](https://docs.garden.io/reference/module-types/helm) module type.
      `,
      moduleOutputsSchema: joi.object().keys({}),
      schema: kubernetesModuleSpecSchema,
      handlers: kubernetesHandlers,
    },
  ],
  extendModuleTypes: [
    {
      name: "container",
      handlers: containerHandlers,
    },
  ],
})
