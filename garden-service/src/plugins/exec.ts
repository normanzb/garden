/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { mapValues } from "lodash"
import { join } from "path"
import { joiArray, joiEnvVars, validateWithPath, joi } from "../config/common"
import { createGardenPlugin } from "../types/plugin/plugin"
import { Module } from "../types/module"
import { CommonServiceSpec } from "../config/service"
import { BaseTestSpec, baseTestSpecSchema } from "../config/test"
import { readModuleVersionFile, writeModuleVersionFile, ModuleVersion } from "../vcs/vcs"
import { GARDEN_BUILD_VERSION_FILENAME } from "../constants"
import { ModuleSpec, BaseBuildSpec, baseBuildSpecSchema, ModuleConfig } from "../config/module"
import { BaseTaskSpec, baseTaskSpecSchema } from "../config/task"
import { dedent } from "../util/string"
import { ConfigureModuleParams, ConfigureModuleResult } from "../types/plugin/module/configure"
import { GetBuildStatusParams, BuildStatus } from "../types/plugin/module/getBuildStatus"
import { BuildModuleParams, BuildResult } from "../types/plugin/module/build"
import { TestModuleParams } from "../types/plugin/module/testModule"
import { TestResult } from "../types/plugin/module/getTestResult"
import { RunTaskParams, RunTaskResult } from "../types/plugin/task/runTask"
import { createOutputStream } from "../util/util"
import { LogLevel } from "../logger/log-node"
import { ConfigurationError } from "../exceptions"
import execa = require("execa")
import { LogEntry } from "../logger/log-entry"

export const name = "exec"

const execPathDoc = dedent`
  By default, the command is run inside the Garden build directory (under .garden/build/<module-name>).
  If the top level \`local\` directive is set to \`true\`, the command runs in the module source directory instead.
`

function execWithStream(cmd: string, log: LogEntry, opts: execa.Options) {
  const proc = execa(cmd, opts)

  const outputStream = createOutputStream(log.placeholder(LogLevel.debug))
  proc.stdout!.pipe(outputStream)
  proc.stderr!.pipe(outputStream)
  return proc
}

export interface ExecTestSpec extends BaseTestSpec {
  command: string[]
  env: { [key: string]: string }
}

export const execTestSchema = baseTestSpecSchema
  .keys({
    command: joi
      .array()
      .items(joi.string())
      .description(
        dedent`
        The command to run to test the module.

        ${execPathDoc}
      `
      )
      .required(),
    env: joiEnvVars(),
  })
  .description("The test specification of an exec module.")

export interface ExecTaskSpec extends BaseTaskSpec {
  command: string[]
  env: { [key: string]: string }
}

export const execTaskSpecSchema = baseTaskSpecSchema
  .keys({
    command: joi
      .array()
      .items(joi.string())
      .description(
        dedent`
        The command to run.

        ${execPathDoc}
      `
      )
      .required(),
    env: joiEnvVars(),
  })
  .description("A task that can be run in this module.")

interface ExecBuildSpec extends BaseBuildSpec {
  command: string[]
}

export interface ExecModuleSpecBase extends ModuleSpec {
  build: ExecBuildSpec
  env: { [key: string]: string }
  tasks: ExecTaskSpec[]
  tests: ExecTestSpec[]
}

export interface ExecModuleSpec extends ExecModuleSpecBase {
  local?: boolean
}

export type ExecModuleConfig = ModuleConfig<ExecModuleSpec>

export const execBuildSpecSchema = baseBuildSpecSchema.keys({
  command: joiArray(joi.string())
    .description(
      dedent`
        The command to run to perform the build.

        ${execPathDoc}
      `
    )
    .example([["npm", "run", "build"], {}]),
})

export const execModuleSpecSchema = joi
  .object()
  .keys({
    local: joi
      .boolean()
      .description(
        dedent`
        If set to true, Garden will run the build command, tests, and tasks in the module source directory,
        instead of in the Garden build directory (under .garden/build/<module-name>).

        Garden will therefore not stage the build for local exec modules. This means that include/exclude filters
        and ignore files are not applied to local exec modules.
      `
      )
      .default(false),
    build: execBuildSpecSchema,
    env: joiEnvVars(),
    tasks: joiArray(execTaskSpecSchema).description("A list of tasks that can be run in this module."),
    tests: joiArray(execTestSchema).description("A list of tests to run in the module."),
  })
  .unknown(false)
  .description("The module specification for an exec module.")

export interface ExecModule extends Module<ExecModuleSpec, CommonServiceSpec, ExecTestSpec> {}

export async function configureExecModule({
  ctx,
  moduleConfig,
}: ConfigureModuleParams<ExecModule>): Promise<ConfigureModuleResult> {
  const buildDeps = moduleConfig.build.dependencies
  if (moduleConfig.spec.local && buildDeps.some((d) => d.copy.length > 0)) {
    const buildDependenciesWithCopySpec = buildDeps
      .filter((d) => !!d.copy)
      .map((d) => d.name)
      .join(", ")
    throw new ConfigurationError(
      dedent`
      Invalid exec module configuration: Module ${moduleConfig.name} copies ${buildDependenciesWithCopySpec}

      A local exec module cannot have a build dependency with a copy spec.
    `,
      {
        buildDependenciesWithCopySpec,
        buildConfig: moduleConfig.build,
      }
    )
  }

  moduleConfig.spec = validateWithPath({
    config: moduleConfig.spec,
    schema: execModuleSpecSchema,
    name: moduleConfig.name,
    path: moduleConfig.path,
    projectRoot: ctx.projectRoot,
  })

  moduleConfig.taskConfigs = moduleConfig.spec.tasks.map((t) => ({
    name: t.name,
    dependencies: t.dependencies,
    timeout: t.timeout,
    spec: t,
  }))

  moduleConfig.testConfigs = moduleConfig.spec.tests.map((t) => ({
    name: t.name,
    dependencies: t.dependencies,
    spec: t,
    timeout: t.timeout,
  }))

  return { moduleConfig }
}

export async function getExecModuleBuildStatus({ module }: GetBuildStatusParams): Promise<BuildStatus> {
  const buildVersionFilePath = join(module.buildMetadataPath, GARDEN_BUILD_VERSION_FILENAME)
  let builtVersion: ModuleVersion | null = null

  try {
    builtVersion = await readModuleVersionFile(buildVersionFilePath)
  } catch (_) {
    // just ignore this error, can be caused by an outdated format
  }

  if (builtVersion && builtVersion.versionString === module.version.versionString) {
    return { ready: true }
  }

  return { ready: false }
}

export async function buildExecModule({ module, log }: BuildModuleParams<ExecModule>): Promise<BuildResult> {
  const output: BuildResult = {}
  const { command } = module.spec.build

  if (command.length) {
    const result = await execWithStream(command.join(" "), log, {
      cwd: module.buildPath,
      env: {
        ...process.env,
        ...mapValues(module.spec.env, (v) => v.toString()),
      },
      shell: true,
    })

    output.fresh = true
    output.buildLog = result.stdout + result.stderr
  }

  // keep track of which version has been built
  const buildVersionFilePath = join(module.buildMetadataPath, GARDEN_BUILD_VERSION_FILENAME)
  await writeModuleVersionFile(buildVersionFilePath, module.version)

  return output
}

export async function testExecModule({ module, log, testConfig }: TestModuleParams<ExecModule>): Promise<TestResult> {
  const startedAt = new Date()
  const { command } = testConfig.spec

  const result = await execWithStream(command.join(" "), log, {
    cwd: module.buildPath,
    env: {
      ...process.env,
      // need to cast the values to strings
      ...mapValues(module.spec.env, (v) => v + ""),
      ...mapValues(testConfig.spec.env, (v) => v + ""),
    },
    reject: false,
    shell: true,
  })

  return {
    moduleName: module.name,
    command,
    testName: testConfig.name,
    version: module.version.versionString,
    success: result.exitCode === 0,
    startedAt,
    completedAt: new Date(),
    log: result.stdout + result.stderr,
  }
}

export async function runExecTask(params: RunTaskParams): Promise<RunTaskResult> {
  const { task, log } = params
  const module = task.module
  const command = task.spec.command
  const startedAt = new Date()

  const result = await execWithStream(command.join(" "), log, {
    cwd: module.buildPath,
    env: {
      ...process.env,
      ...mapValues(module.spec.env, (v) => v.toString()),
      ...mapValues(task.spec.env, (v) => v.toString()),
    },
    shell: true,
  })

  const completedAt = new Date()
  const output = result.stdout + result.stderr

  return <RunTaskResult>{
    moduleName: module.name,
    taskName: task.name,
    command,
    version: module.version.versionString,
    // the exec call throws on error so we can assume success if we made it this far
    success: true,
    log: output,
    outputs: {
      log: output,
    },
    startedAt,
    completedAt,
  }
}

export const execPlugin = createGardenPlugin({
  name: "exec",
  createModuleTypes: [
    {
      name: "exec",
      docs: dedent`
      A simple module for executing commands in your shell. This can be a useful escape hatch if no other module
      type fits your needs, and you just need to execute something (as opposed to deploy it, track its status etc.).

      By default, the \`exec\` module type executes the commands in the Garden build directory
      (under .garden/build/<module-name>). By setting \`local: true\`, the commands are executed in the module
      source directory instead.

      Note that Garden does not sync the source code for local exec modules into the Garden build directory.
      This means that include/exclude filters and ignore files are not applied to local exec modules, as the
      filtering is done during the sync.
    `,
      moduleOutputsSchema: joi.object().keys({}),
      schema: execModuleSpecSchema,
      taskOutputsSchema: joi.object().keys({
        log: joi
          .string()
          .allow("")
          .default("")
          .description(
            "The full log from the executed task. " +
              "(Pro-tip: Make it machine readable so it can be parsed by dependant tasks and services!)"
          ),
      }),
      handlers: {
        configure: configureExecModule,
        getBuildStatus: getExecModuleBuildStatus,
        build: buildExecModule,
        runTask: runExecTask,
        testModule: testExecModule,
      },
    },
  ],
})

export const gardenPlugin = execPlugin
