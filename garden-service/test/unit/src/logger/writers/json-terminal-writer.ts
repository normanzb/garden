import { expect } from "chai"

import { JsonTerminalWriter } from "../../../../../src/logger/writers/json-terminal-writer"
import { getLogger } from "../../../../../src/logger/logger"

const logger: any = getLogger()

beforeEach(() => {
  logger.children = []
})

describe("JsonTerminalWriter", () => {
  describe("render", () => {
    it("should return a JSON-formatted message if level is geq than entry level", () => {
      const writer = new JsonTerminalWriter()
      const entry = logger.info("hello logger")
      const out = writer.render(entry, logger)
      expect(out).to.eql('{"msg":"hello logger","section":""}')
    })
    it("should chain messages with 'append' set to true", () => {
      const writer = new JsonTerminalWriter()
      const entry = logger.info("hello logger")
      entry.setState({ msg: "hello again", append: true })
      const out = writer.render(entry, logger)
      expect(out).to.eql('{"msg":"hello logger - hello again","section":""}')
    })
    it("should return null if message is an empty string", () => {
      const writer = new JsonTerminalWriter()
      const entry = logger.info("")
      const out = writer.render(entry, logger)
      expect(out).to.eql(null)
    })
    it("should return null if entry is empty", () => {
      const writer = new JsonTerminalWriter()
      const entry = logger.placeholder()
      const out = writer.render(entry, logger)
      expect(out).to.eql(null)
    })
    it("should return null if entry level is geq to writer level", () => {
      const writer = new JsonTerminalWriter()
      const entry = logger.verbose("abc")
      const out = writer.render(entry, logger)
      expect(out).to.eql(null)
    })
  })
})
