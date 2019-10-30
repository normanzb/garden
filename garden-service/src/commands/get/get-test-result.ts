/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { Command, CommandResult, CommandParams, StringParameter } from "../base"
import { NotFoundError } from "../../exceptions"
import { TestResult } from "../../types/plugin/module/getTestResult"
import { getTestVersion } from "../../tasks/test"
import { findByName, getNames } from "../../util/util"
import { printHeader } from "../../logger/util"
import chalk from "chalk"

const getTestResultArgs = {
  module: new StringParameter({
    help: "Module name of where the test runs.",
    required: true,
  }),
  name: new StringParameter({
    help: "Test name.",
    required: true,
  }),
}

export type GetTestResultCommandResult = TestResult | null

type Args = typeof getTestResultArgs

export class GetTestResultCommand extends Command<Args> {
  name = "test-result"
  help = "Outputs the latest execution result of a provided test."

  arguments = getTestResultArgs

  async action({
    garden,
    log,
    headerLog,
    args,
  }: CommandParams<Args>): Promise<CommandResult<GetTestResultCommandResult>> {
    const testName = args.name
    const moduleName = args.module

    printHeader(
      headerLog,
      `Test result for test ${chalk.cyan(testName)} in module ${chalk.cyan(moduleName)}`,
      "heavy_check_mark"
    )

    const graph = await garden.getConfigGraph()
    const actions = await garden.getActionRouter()

    const module = await graph.getModule(moduleName)

    const testConfig = findByName(module.testConfigs, testName)

    if (!testConfig) {
      throw new NotFoundError(`Could not find test "${testName}" in module "${moduleName}"`, {
        moduleName,
        testName,
        availableTests: getNames(module.testConfigs),
      })
    }

    const testVersion = await getTestVersion(garden, graph, module, testConfig)

    const result = await actions.getTestResult({
      log,
      testName,
      module,
      testVersion,
    })

    if (result === null) {
      log.info(`Could not find results for test '${testName}'`)
    } else {
      log.info({ data: result })
    }

    return { result }
  }
}
