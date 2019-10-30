/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { resolve } from "path"
import { startCase, mapValues } from "lodash"
import split2 = require("split2")

import { ConfigurationError, PluginError, RuntimeError } from "../../exceptions"
import { LogEntry } from "../../logger/log-entry"
import { dedent, deline } from "../../util/string"
import { terraform } from "./cli"
import { TerraformProvider } from "./terraform"
import { PluginContext } from "../../plugin-context"
import { joi, PrimitiveMap, joiStringMap } from "../../config/common"
import { writeFile } from "fs-extra"
import chalk from "chalk"

export const noAutoApplyMsg = deline`
  Terraform stack is not up-to-date and \`autoApply\` is not enabled. Please run \`terraform apply\` to make sure
  the stack is in the intended state.
`

export const variablesSchema = joiStringMap(joi.any())

export interface TerraformBaseSpec {
  autoApply: boolean
  dependencies: string[]
  variables: PrimitiveMap
  version: string
}

export async function tfValidate(log: LogEntry, provider: TerraformProvider, root: string, variables: object) {
  const args = ["validate", "-json", ...(await prepareVariables(root, variables))]
  const tfVersion = provider.config.version

  const res = await terraform(tfVersion).json({
    log,
    args,
    ignoreError: true,
    cwd: root,
  })

  if (res.valid === false) {
    const reasons = res.diagnostics.map((d: any) => d.summary)

    if (reasons.includes("Could not satisfy plugin requirements")) {
      // We need to run `terraform init` and retry validation
      log.info("Initializing Terraform")
      await terraform(tfVersion).exec({ log, args: ["init"], cwd: root })

      const retryRes = await terraform(tfVersion).json({
        log,
        args,
        ignoreError: true,
        cwd: root,
      })
      if (retryRes.valid === "false") {
        throw tfValidationError(retryRes)
      }
    } else {
      throw tfValidationError(res)
    }
  }
}

export async function getTfOutputs(log: LogEntry, terraformVersion: string, workingDir: string) {
  const res = await terraform(terraformVersion).json({
    log,
    args: ["output", "-json"],
    cwd: workingDir,
  })
  return mapValues(res, (v: any) => v.value)
}

export function getRoot(ctx: PluginContext, provider: TerraformProvider) {
  return resolve(ctx.projectRoot, provider.config.initRoot || ".")
}

export function tfValidationError(result: any) {
  const errors = result.diagnostics.map((d: any) => `${startCase(d.severity)}: ${d.summary}\n${d.detail || ""}`)
  return new ConfigurationError(dedent`Failed validating Terraform configuration:\n\n${errors.join("\n")}`, {
    result,
  })
}

interface GetTerraformStackStatusParams {
  log: LogEntry
  provider: TerraformProvider
  autoApply: boolean
  root: string
  variables: object
}

/**
 * Checks and returns the status of a Terraform stack.
 *
 * Note: If `autoApply` is set to `false` and the stack is not ready, we still return `ready: true` and log a warning,
 * since the user may want to manually update their stacks. The `autoApply` flag is only for information, and setting
 * it to `true` does _not_ mean this method will apply the change.
 */
export async function getStackStatus({ log, provider, autoApply, root, variables }: GetTerraformStackStatusParams) {
  await tfValidate(log, provider, root, variables)
  const tfVersion = provider.config.version

  const plan = await terraform(tfVersion).exec({
    log,
    ignoreError: true,
    args: ["plan", "-detailed-exitcode", "-input=false", ...(await prepareVariables(root, variables))],
    cwd: root,
  })

  if (plan.exitCode === 0) {
    // Stack is up-to-date
    const outputs = await getTfOutputs(log, tfVersion, root)
    return { ready: true, outputs }
  } else if (plan.exitCode === 1) {
    // Error from terraform. This can, for example, happen if variables are missing or there are errors in the tf files.
    throw new ConfigurationError(`terraform plan returned an error:\n${plan.stderr}`, {
      output: plan.stderr,
    })
  } else if (plan.exitCode === 2) {
    // No error but stack is not up-to-date
    if (autoApply) {
      // Trigger the prepareEnvironment handler
      return { ready: false, outputs: {} }
    } else {
      log.warn(noAutoApplyMsg)
      const outputs = await getTfOutputs(log, tfVersion, root)
      return { ready: true, outputs }
    }
  } else {
    throw new PluginError(`Unexpected exit code from \`terraform plan\`: ${plan.exitCode}`, {
      exitCode: plan.exitCode,
      stderr: plan.stderr,
      stdout: plan.stdout,
    })
  }
}

export async function applyStack(log: LogEntry, provider: TerraformProvider, root: string, variables: object) {
  const tfVersion = provider.config.version
  const args = ["apply", "-auto-approve", "-input=false", ...(await prepareVariables(root, variables))]

  const proc = await terraform(tfVersion).spawn({ log, args, cwd: root })

  const statusLine = log.info("→ Applying Terraform stack...")

  const logStream = split2()

  let stdout: string = ""
  let stderr: string = ""

  if (proc.stdout) {
    proc.stdout.pipe(logStream)
    proc.stdout.on("data", (data) => {
      stdout += data
    })
  }

  if (proc.stderr) {
    proc.stderr.pipe(logStream)
    proc.stderr.on("data", (data) => {
      stderr += data
    })
  }

  logStream.on("data", (line: Buffer) => {
    statusLine.setState(chalk.gray("→ ") + line.toString())
  })

  await new Promise((_resolve, reject) => {
    proc.on("error", reject)
    proc.on("close", (code) => {
      if (code === 0) {
        _resolve()
      } else {
        reject(
          new RuntimeError(`Error when applying Terraform stack:\n${stderr}`, {
            stdout,
            stderr,
            code,
          })
        )
      }
    })
  })
}

/**
 * If any variables are specified in the Garden config, this prepares a .tfvars file to use and returns the
 * appropriate arguments to pass to the Terraform CLI, otherwise an empty array.
 */
export async function prepareVariables(targetDir: string, variables?: object): Promise<string[]> {
  if (Object.entries(variables || {}).length === 0) {
    return []
  }

  const path = resolve(targetDir, "garden.tfvars.json")
  await writeFile(path, JSON.stringify(variables))

  return ["-var-file", path]
}
