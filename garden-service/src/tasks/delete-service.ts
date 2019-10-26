/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { LogEntry } from "../logger/log-entry"
import { BaseTask, TaskType } from "./base"
import { Service, ServiceStatus } from "../types/service"
import { Garden } from "../garden"
import { ConfigGraph } from "../config-graph"
import { TaskResults, TaskResult } from "../task-graph"

export interface DeleteServiceTaskParams {
  garden: Garden
  graph: ConfigGraph
  service: Service
  log: LogEntry
  includeDependants?: boolean
}

export class DeleteServiceTask extends BaseTask {
  type: TaskType = "delete-service"

  private graph: ConfigGraph
  private service: Service
  private includeDependants: boolean

  constructor(
    { garden, graph, log, service, includeDependants = false }:
      DeleteServiceTaskParams,
  ) {
    super({ garden, log, force: false, version: service.module.version })
    this.graph = graph
    this.service = service
    this.includeDependants = includeDependants
  }

  async getDependencies() {
    if (!this.includeDependants) {
      return []
    }

    const deps = await this.graph.getDependants("service", this.getName(), false)

    return deps.service.map(service => {
      return new DeleteServiceTask({
        garden: this.garden,
        graph: this.graph,
        log: this.log,
        service,
        includeDependants: this.includeDependants,
      })
    })
  }

  getName() {
    return this.service.name
  }

  getDescription() {
    return `deleting service '${this.service.name}' (from module '${this.service.module.name}')`
  }

  async process(): Promise<ServiceStatus> {
    const actions = await this.garden.getActionRouter()
    let status: ServiceStatus

    try {
      status = await actions.deleteService({ log: this.log, service: this.service })
    } catch (err) {
      this.log.setError()
      throw err
    }

    return status
  }

}

export function deletedServiceStatuses(results: TaskResults): { [serviceName: string]: ServiceStatus } {
  const deleted = <TaskResult[]>Object.values(results)
    .filter(r => r && r.type === "delete-service")
  const statuses = {}

  for (const res of deleted) {
    statuses[res.name] = res.output
  }

  return statuses
}
