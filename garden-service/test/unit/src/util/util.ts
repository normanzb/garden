import { expect } from "chai"
import { describe } from "mocha"
import {
  pickKeys,
  getEnvVarName,
  deepOmitUndefined,
  deepFilter,
  splitLast,
  exec,
  createOutputStream,
  makeErrorMsg,
  renderOutputStream,
  spawn,
} from "../../../../src/util/util"
import { expectError } from "../../../helpers"
import { splitFirst } from "../../../../src/util/util"
import { getLogger } from "../../../../src/logger/logger"
import { dedent } from "../../../../src/util/string"

describe("util", () => {
  describe("makeErrorMsg", () => {
    it("should return an error message", () => {
      const msg = makeErrorMsg({
        code: 1,
        cmd: "ls",
        args: ["some-dir"],
        error: "dir not found",
        output: "dir not found",
      })
      expect(msg).to.equal(dedent`
        Command "ls some-dir" failed with code 1:

        dir not found
      `)
    })
    it("should ignore emtpy args", () => {
      const msg = makeErrorMsg({
        code: 1,
        cmd: "ls",
        args: [],
        error: "dir not found",
        output: "dir not found",
      })
      expect(msg).to.equal(dedent`
        Command "ls" failed with code 1:

        dir not found
      `)
    })
    it("should include output if it's not the same as the error", () => {
      const msg = makeErrorMsg({
        code: 1,
        cmd: "ls some-dir",
        args: [],
        error: "dir not found",
        output: "dir not found and some more output",
      })
      expect(msg).to.equal(dedent`
        Command "ls some-dir" failed with code 1:

        dir not found

        Here's the full output:

        dir not found and some more output
      `)
    })
    it("should include the last 100 lines of output if output is very long", () => {
      const output = "All work and no play\n"
      const outputFull = output.repeat(102)
      const outputPartial = output.repeat(99) // This makes 100 lines in total

      const msg = makeErrorMsg({
        code: 1,
        cmd: "ls some-dir",
        args: [],
        error: "dir not found",
        output: outputFull,
      })
      expect(msg).to.equal(dedent`
        Command "ls some-dir" failed with code 1:

        dir not found

        Here are the last 100 lines of the output:

        ${outputPartial}
      `)
    })
  })
  describe("exec", () => {
    before(function() {
      // These tests depend the underlying OS and are only executed on macOS
      if (process.platform !== "darwin") {
        // tslint:disable-next-line: no-invalid-this
        this.skip()
      }
    })
    it("should successfully execute a command", async () => {
      const res = await exec("echo", ["hello"])
      expect(res.stdout).to.equal("hello")
    })
    it("should handle command and args in a single string", async () => {
      const res = await exec("echo hello && echo world", [], { shell: true })
      expect(res.stdout).to.equal("hello\nworld")
    })
    it("should optionally pipe stdout and stderr to an output stream", async () => {
      const logger = getLogger()
      const entry = logger.placeholder()
      const errorEntry = logger.placeholder()

      await exec("echo hello", [], { outputStream: createOutputStream(entry) })
      await exec("ls scottiepippen", [], { outputStream: createOutputStream(errorEntry), reject: false })
      expect(entry.getMessageState().msg).to.equal(renderOutputStream("hello"))
      expect(errorEntry.getMessageState().msg).to.equal(
        renderOutputStream("ls: scottiepippen: No such file or directory"),
      )
    })
    it("should throw a standardised error message on error", async () => {
      try {
        await exec("ls scottiepippen")
      } catch (err) {
        expect(err.message).to.equal(makeErrorMsg({
          code: 1,
          cmd: "ls scottiepippen",
          args: [],
          output: "ls: scottiepippen: No such file or directory",
          error: "ls: scottiepippen: No such file or directory",
        }))
      }
    })
  })

  describe("spawn", () => {
    before(function() {
      // These tests depend on the underlying OS and are only executed on macOS
      if (process.platform !== "darwin") {
        // tslint:disable-next-line: no-invalid-this
        this.skip()
      }
    })
    it("should throw a standardised error message on error", async () => {
      try {
        await spawn("ls", ["scottiepippen"])
      } catch (err) {
        expect(err.message).to.equal(makeErrorMsg({
          code: 1,
          cmd: "ls scottiepippen",
          args: [],
          output: "ls: scottiepippen: No such file or directory",
          error: "ls: scottiepippen: No such file or directory",
        }))
      }
    })
  })

  describe("getEnvVarName", () => {
    it("should translate the service name to a name appropriate for env variables", async () => {
      expect(getEnvVarName("service-b")).to.equal("SERVICE_B")
    })
  })

  describe("pickKeys", () => {
    it("should pick keys from an object", () => {
      const obj = { a: 1, b: 2, c: 3 }
      expect(pickKeys(obj, ["a", "b"])).to.eql({ a: 1, b: 2 })
    })

    it("should throw if one or more keys are missing", async () => {
      const obj = { a: 1, b: 2, c: 3 }
      await expectError(() => pickKeys(obj, <any>["a", "foo", "bar"]), (err) => {
        expect(err.message).to.equal("Could not find key(s): foo, bar")
        expect(err.detail.missing).to.eql(["foo", "bar"])
        expect(err.detail.available).to.eql(["a", "b", "c"])
      })
    })

    it("should use given description in error message", async () => {
      const obj = { a: 1, b: 2, c: 3 }
      await expectError(() => pickKeys(obj, <any>["a", "foo", "bar"], "banana"), (err) => {
        expect(err.message).to.equal("Could not find banana(s): foo, bar")
      })
    })
  })

  describe("deepFilter", () => {
    const fn = v => v !== 99

    it("should filter keys in a simple object", () => {
      const obj = {
        a: 1,
        b: 2,
        c: 99,
      }
      expect(deepFilter(obj, fn)).to.eql({ a: 1, b: 2 })
    })

    it("should filter keys in a nested object", () => {
      const obj = {
        a: 1,
        b: 2,
        c: { d: 3, e: 99 },
      }
      expect(deepFilter(obj, fn)).to.eql({ a: 1, b: 2, c: { d: 3 } })
    })

    it("should filter values in lists", () => {
      const obj = {
        a: 1,
        b: 2,
        c: [3, 99],
      }
      expect(deepFilter(obj, fn)).to.eql({ a: 1, b: 2, c: [3] })
    })

    it("should filter keys in objects in lists", () => {
      const obj = {
        a: 1,
        b: 2,
        c: [
          { d: 3, e: 99 },
        ],
      }
      expect(deepFilter(obj, fn)).to.eql({ a: 1, b: 2, c: [{ d: 3 }] })
    })
  })

  describe("deepOmitUndefined", () => {
    it("should omit keys with undefined values in a simple object", () => {
      const obj = {
        a: 1,
        b: 2,
        c: undefined,
      }
      expect(deepOmitUndefined(obj)).to.eql({ a: 1, b: 2 })
    })

    it("should omit keys with undefined values in a nested object", () => {
      const obj = {
        a: 1,
        b: 2,
        c: { d: 3, e: undefined },
      }
      expect(deepOmitUndefined(obj)).to.eql({ a: 1, b: 2, c: { d: 3 } })
    })

    it("should omit undefined values in lists", () => {
      const obj = {
        a: 1,
        b: 2,
        c: [3, undefined],
      }
      expect(deepOmitUndefined(obj)).to.eql({ a: 1, b: 2, c: [3] })
    })

    it("should omit undefined values in objects in lists", () => {
      const obj = {
        a: 1,
        b: 2,
        c: [
          { d: 3, e: undefined },
        ],
      }
      expect(deepOmitUndefined(obj)).to.eql({ a: 1, b: 2, c: [{ d: 3 }] })
    })
  })

  describe("splitFirst", () => {
    it("should split string on first occurrence of given delimiter", () => {
      expect(splitFirst("foo:bar:boo", ":")).to.eql(["foo", "bar:boo"])
    })

    it("should return the whole string as first element when no delimiter is found in string", () => {
      expect(splitFirst("foo", ":")).to.eql(["foo", ""])
    })
  })

  describe("splitLast", () => {
    it("should split string on last occurrence of given delimiter", () => {
      expect(splitLast("foo:bar:boo", ":")).to.eql(["foo:bar", "boo"])
    })

    it("should return the whole string as last element when no delimiter is found in string", () => {
      expect(splitLast("foo", ":")).to.eql(["", "foo"])
    })
  })
})
