/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import React, { useEffect } from "react"
import { useApi } from "../contexts/api"
import { getDuration, getTestKey } from "../util/helpers"
import EntityResult from "../components/entity-result"
import { ErrorNotification } from "../components/notifications"
import { EntityResultSupportedTypes } from "../contexts/ui"
import { loadTestResult, loadTaskResult } from "../api/actions"
import { RunResult } from "garden-service/build/src/types/plugin/base"

const ErrorMsg = ({ error, type }) => (
  <ErrorNotification>
    Error occured while trying to get {type} result: {error.message}
  </ErrorNotification>
)

function prepareData(data: RunResult) {
  const startedAt = data.startedAt
  const completedAt = data.completedAt
  const duration = startedAt && completedAt && getDuration(startedAt, completedAt)

  const output = data.log
  return { duration, startedAt, completedAt, output }
}

interface Props {
  type: EntityResultSupportedTypes
  name: string
  moduleName: string
  onClose: () => void
}

/**
 * Returns the InfoPane for a given node type.
 *
 * If the node is of type "test" or "run", it loads the results as well.
 */
export default ({ name, moduleName, type, onClose }: Props) => {
  const {
    dispatch,
    store: { entities, requestStates },
  } = useApi()

  const { tasks, tests } = entities

  const loadResults = () => {
    if (type === "test") {
      loadTestResult({ dispatch, name, moduleName })
    } else if (type === "run" || type === "task") {
      loadTaskResult({ name, dispatch })
    }
  }

  useEffect(loadResults, [name, moduleName])

  if (type === "test") {
    const testKey = getTestKey({ moduleName, testName: name })

    const testResult = tests && tests[testKey] && tests[testKey].result

    if (requestStates.testResult.error) {
      return <ErrorMsg error={requestStates.testResult.error} type={type} />
    }

    return (
      <EntityResult
        onRefresh={loadResults}
        loading={requestStates.testResult.pending}
        onClose={onClose}
        name={name}
        type={type}
        moduleName={moduleName}
        {...(!requestStates.testResult.pending && testResult && prepareData(testResult))}
      />
    )
  } else if (type === "task" || type === "run") {
    const taskResult = tasks && tasks[name] && tasks[name].result

    if (requestStates.taskResult.error) {
      return <ErrorMsg error={requestStates.taskResult.error} type={type} />
    }

    return (
      <EntityResult
        onRefresh={loadResults}
        loading={requestStates.taskResult.pending}
        onClose={onClose}
        name={name}
        type={type}
        moduleName={moduleName}
        {...(!requestStates.taskResult.pending && taskResult && prepareData(taskResult))}
      />
    )
  } else {
    return <EntityResult onClose={onClose} name={name} type={type} moduleName={moduleName} />
  }
}
