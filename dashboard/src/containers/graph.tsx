/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import React, { useEffect } from "react"
import styled from "@emotion/styled"
import Graph from "../components/graph"
import PageError from "../components/page-error"
import { TaskState, useApi } from "../contexts/api"
import { StackGraphSupportedFilterKeys, EntityResultSupportedTypes, useUiState } from "../contexts/ui"
import EntityResult from "./entity-result"
import Spinner from "../components/spinner"
import { Filters } from "../components/group-filter"
import { capitalize } from "lodash"
import { RenderedNode } from "garden-service/build/src/config-graph"
import { GraphOutput } from "garden-service/build/src/commands/get/get-graph"
import { loadGraph } from "../api/actions"
import { useConfig } from "../util/hooks"
import { getTestKey } from "../util/helpers"

const Wrapper = styled.div`
  padding-left: 0.75rem;
`

export interface RenderedNodeWithStatus extends RenderedNode {
  status?: TaskState
}
export interface GraphOutputWithNodeStatus extends GraphOutput {
  nodes: RenderedNodeWithStatus[]
}

export default () => {
  const {
    dispatch,
    store: { entities, requestStates },
  } = useApi()

  const { project, modules, services, tests, tasks, graph } = entities

  const {
    actions: { selectGraphNode, stackGraphToggleItemsView, clearGraphNodeSelection },
    state: {
      selectedGraphNode,
      isSidebarOpen,
      stackGraph: { filters },
    },
  } = useUiState()

  useConfig(dispatch, requestStates.config)

  useEffect(() => {
    const fetchData = async () => loadGraph(dispatch)

    if (!(requestStates.graph.initLoadComplete || requestStates.graph.pending)) {
      fetchData()
    }
  }, [dispatch, requestStates.graph])

  if (requestStates.graph.error) {
    return <PageError error={requestStates.graph.error} />
  }

  if (!requestStates.graph.initLoadComplete) {
    return <Spinner />
  }

  const nodesWithStatus: RenderedNodeWithStatus[] = graph.nodes.map((node) => {
    let taskState: TaskState = "taskComplete"
    switch (node.type) {
      case "publish":
        break
      case "deploy":
        taskState = (services[node.name] && services[node.name].taskState) || taskState
        break
      case "build":
        taskState = (modules[node.name] && modules[node.name].taskState) || taskState
        break
      case "run":
        taskState = (tasks[node.name] && tasks[node.name].taskState) || taskState
        break
      case "test":
        const testKey = getTestKey({ testName: node.name, moduleName: node.moduleName })
        taskState = (tests[testKey] && tests[testKey].taskState) || taskState
        break
    }
    return { ...node, status: taskState }
  })

  let graphWithStatus: GraphOutputWithNodeStatus = { nodes: nodesWithStatus, relationships: graph.relationships }

  let moreInfoPane: React.ReactNode = null
  if (selectedGraphNode && graph) {
    const node = graph.nodes.find((n) => n.key === selectedGraphNode)
    if (node) {
      moreInfoPane = (
        <div className="col-xs-5 col-sm-5 col-md-4 col-lg-4 col-xl-4">
          <EntityResult
            name={node.name}
            type={node.type as EntityResultSupportedTypes}
            moduleName={node.moduleName}
            onClose={clearGraphNodeSelection}
          />
        </div>
      )
    }
  }

  const graphFilters = Object.keys(filters).reduce((allGroupFilters, type) => {
    return {
      ...allGroupFilters,
      [type]: {
        label: capitalize(type),
        selected: filters[type],
      },
    }
  }, {}) as Filters<StackGraphSupportedFilterKeys>

  return (
    <Wrapper className="row">
      <div className={moreInfoPane ? "col-xs-7 col-sm-7 col-md-8 col-lg-8 col-xl-8" : "col-xs"}>
        <Graph
          onGraphNodeSelected={selectGraphNode}
          selectedGraphNode={selectedGraphNode}
          layoutChanged={isSidebarOpen}
          graph={graphWithStatus}
          filters={graphFilters}
          onFilter={stackGraphToggleItemsView}
          isProcessing={project.taskGraphProcessing}
        />
      </div>
      {moreInfoPane}
    </Wrapper>
  )
}
