/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { TaskResults } from "../task-graph"
import { ModuleVersion } from "../vcs/vcs"
import { v1 as uuidv1 } from "uuid"
import { Garden } from "../garden"
import { LogEntry } from "../logger/log-entry"
import { pickBy, mapValues, mapKeys } from "lodash"
import { ServiceStatus } from "../types/service"
import { RunTaskResult } from "../types/plugin/task/runTask"
import { splitLast } from "../util/util"

export type TaskType =
  "build" |
  "delete-service" |
  "deploy" |
  "get-service-status" |
  "get-task-result" |
  "hot-reload" |
  "publish" |
  "resolve-provider" |
  "task" |
  "test"

export class TaskDefinitionError extends Error { }

export function makeBaseKey(type: TaskType, name: string) {
  return `${type}.${name}`
}

export interface TaskParams {
  garden: Garden
  log: LogEntry
  force?: boolean
  version: ModuleVersion
}

export abstract class BaseTask {
  abstract type: TaskType
  garden: Garden
  log: LogEntry
  uid: string
  force: boolean
  version: ModuleVersion

  dependencies: BaseTask[]

  constructor(initArgs: TaskParams) {
    this.garden = initArgs.garden
    this.dependencies = []
    this.uid = uuidv1() // uuidv1 is timestamp-based
    this.force = !!initArgs.force
    this.version = initArgs.version
    this.log = initArgs.log
  }

  async getDependencies(): Promise<BaseTask[]> {
    return this.dependencies
  }

  abstract getName(): string

  getKey(): string {
    return makeBaseKey(this.type, this.getName())
  }

  getId(): string {
    return `${this.getKey()}.${this.uid}`
  }

  abstract getDescription(): string

  abstract async process(dependencyResults: TaskResults): Promise<any>
}

export function getServiceStatuses(dependencyResults: TaskResults): { [name: string]: ServiceStatus } {
  const getServiceStatusResults = pickBy(dependencyResults, r => r && r.type === "get-service-status")
  const deployResults = pickBy(dependencyResults, r => r && r.type === "deploy")
  // DeployTask results take precedence over GetServiceStatusTask results, because status changes after deployment
  const combined = { ...getServiceStatusResults, ...deployResults }
  const statuses = mapValues(combined, r => r!.output as ServiceStatus)
  return mapKeys(statuses, (_, key) => splitLast(key, ".")[1])
}

export function getRunTaskResults(dependencyResults: TaskResults): { [name: string]: RunTaskResult } {
  const storedResults = pickBy(dependencyResults, r => r && r.type === "get-task-result")
  const runResults = pickBy(dependencyResults, r => r && r.type === "task")
  // TaskTask results take precedence over GetTaskResultTask results
  const combined = { ...storedResults, ...runResults }
  const results = mapValues(combined, r => r!.output as RunTaskResult)
  return mapKeys(results, (_, key) => splitLast(key, ".")[1])
}
