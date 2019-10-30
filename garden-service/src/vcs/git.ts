/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import execa from "execa"
import { join, resolve, relative } from "path"
import { flatten } from "lodash"
import { ensureDir, pathExists, stat, createReadStream } from "fs-extra"
import { PassThrough } from "stream"
import hasha from "hasha"
import split2 = require("split2")

import { VcsHandler, RemoteSourceParams, VcsFile, GetFilesParams } from "./vcs"
import { ConfigurationError, RuntimeError } from "../exceptions"
import Bluebird from "bluebird"
import { matchPath } from "../util/fs"
import { deline } from "../util/string"
import { splitLast } from "../util/util"
import { LogEntry } from "../logger/log-entry"
import parseGitConfig from "parse-git-config"

export function getCommitIdFromRefList(refList: string[]): string {
  try {
    return refList[0].split("\t")[0]
  } catch (err) {
    return refList[0]
  }
}

export function parseGitUrl(url: string) {
  const parts = splitLast(url, "#")
  if (!parts[0]) {
    throw new ConfigurationError(
      deline`
        Repository URLs must contain a hash part pointing to a specific branch or tag
        (e.g. https://github.com/org/repo.git#master)`,
      { repositoryUrl: url }
    )
  }
  const parsed = { repositoryUrl: parts[0], hash: parts[1] }
  return parsed
}

interface GitCli {
  (...args: string[]): Promise<string[]>
}

interface Submodule {
  path: string
  url: string
}

// TODO Consider moving git commands to separate (and testable) functions
export class GitHandler extends VcsHandler {
  name = "git"

  private gitCli(log: LogEntry, cwd: string): GitCli {
    return async (...args: string[]) => {
      log.silly(`Calling git with args '${args.join(" ")}'`)
      const { stdout } = await execa("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 })
      return stdout.split("\n").filter((line) => line.length > 0)
    }
  }

  private async getModifiedFiles(git: GitCli, path: string) {
    try {
      return await git("diff-index", "--name-only", "HEAD", path)
    } catch (err) {
      if (err.exitCode === 128) {
        // no commit in repo
        return []
      } else {
        throw err
      }
    }
  }

  async getRepoRoot(log: LogEntry, path: string) {
    const git = this.gitCli(log, path)

    try {
      return (await git("rev-parse", "--show-toplevel"))[0]
    } catch (err) {
      if (err.exitCode === 128) {
        // Throw nice error when we detect that we're not in a repo root
        throw new RuntimeError(
          deline`
          Path ${path} is not in a git repository root. Garden must be run from within a git repo.
          Please run \`git init\` if you're starting a new project and repository, or move the project to an
          existing repository, and try again.
        `,
          { path }
        )
      } else {
        throw err
      }
    }
  }

  /**
   * Returns a list of files, along with file hashes, under the given path, taking into account the configured
   * .ignore files, and the specified include/exclude filters.
   */
  async getFiles({ log, path, include, exclude }: GetFilesParams): Promise<VcsFile[]> {
    const git = this.gitCli(log, path)
    const gitRoot = await this.getRepoRoot(log, path)

    // List modified files, so that we can ensure we have the right hash for them later
    const modified = new Set(
      (await this.getModifiedFiles(git, path))
        // The output here is relative to the git root, and not the directory `path`
        .map((modifiedRelPath) => resolve(gitRoot, modifiedRelPath))
    )

    // List tracked but ignored files (we currently exclude those as well, so we need to query that specially)
    const trackedButIgnored = new Set(
      this.ignoreFiles.length === 0
        ? []
        : flatten(
            await Promise.all(this.ignoreFiles.map((f) => git("ls-files", "--ignored", "--exclude-per-directory", f)))
          )
    )

    // List all submodule paths in the current repo
    const submodulePaths = (await this.getSubmodules(gitRoot)).map((s) => join(gitRoot, s.path))

    // We run ls-files for each ignoreFile and do a manual set-intersection (by counting elements in an object)
    // in order to optimize the flow.
    const paths: { [path: string]: number } = {}
    const files: VcsFile[] = []

    // This function is called for each line output from the ls-files commands that we run, and populates the
    // `files` array.
    const handleLine = (data: Buffer) => {
      const line = data.toString().trim()
      if (!line) {
        return
      }

      let filePath: string
      let hash = ""

      const split = line.trim().split("\t")

      if (split.length === 1) {
        // File is untracked
        filePath = split[0]
      } else {
        filePath = split[1]
        hash = split[0].split(" ")[1]
      }

      // Ignore files that are tracked but still specified in ignore files
      if (trackedButIgnored.has(filePath)) {
        return
      }

      const resolvedPath = resolve(path, filePath)

      // Add the path to `paths` or increment the counter to indicate how many of the ls-files outputs
      // contain the path.
      if (paths[resolvedPath]) {
        paths[resolvedPath] += 1
      } else {
        paths[resolvedPath] = 1
      }

      // We push to the output array when all ls-files commands "agree" that it should be included,
      // and it passes through the include/exclude filters.
      if (
        paths[resolvedPath] >= this.ignoreFiles.length &&
        (matchPath(filePath, include, exclude) || submodulePaths.includes(resolvedPath))
      ) {
        files.push({ path: resolvedPath, hash })
      }
    }

    const lsFiles = async (ignoreFile?: string) => {
      const args = ["ls-files", "-s", "--others", "--exclude", this.gardenDirPath]
      if (ignoreFile) {
        args.push("--exclude-per-directory", ignoreFile)
      }
      args.push(path)

      const proc = execa("git", args, { cwd: path })

      // Split the command output by line
      const splitStream = split2()
      splitStream.on("data", handleLine)
      proc.stdout!.pipe(splitStream)

      try {
        await proc
      } catch (err) {
        // if we get 128 we're not in a repo root, so we just get no files. Otherwise we throw.
        if (err.exitCode !== 128) {
          throw err
        }
      }
    }

    if (this.ignoreFiles.length === 0) {
      await lsFiles()
    } else {
      // We run ls-files for each ignore file and collect each return result line with `handleLine`
      await Bluebird.map(this.ignoreFiles, lsFiles)
    }

    // Resolve submodules
    const withSubmodules = flatten(
      await Bluebird.map(files, async (f) => {
        if (submodulePaths.includes(f.path)) {
          // This path is a submodule, so we recursively call getFiles for that path again.
          // Note: We apply include/exclude filters after listing files from submodule
          return (await this.getFiles({ log, path: f.path, exclude: [] })).filter((submoduleFile) =>
            matchPath(relative(path, submoduleFile.path), include, exclude)
          )
        } else {
          return [f]
        }
      })
    )

    // Make sure we have a fresh hash for each file
    return Bluebird.map(withSubmodules, async (f) => {
      const resolvedPath = resolve(path, f.path)
      if (!f.hash || modified.has(resolvedPath)) {
        // If we can't compute the hash, i.e. the file is gone, we filter it out below
        let hash = ""
        try {
          // "git ls-files" returns a symlink even if it points to a directory.
          // We filter symlinked directories out, since hashObject() will fail to
          // process them.
          if (!(await stat(resolvedPath)).isDirectory()) {
            hash = (await this.hashObject(resolvedPath)) || ""
          }
        } catch (err) {
          // 128 = File no longer exists
          if (err.exitCode !== 128 && err.code !== "ENOENT") {
            throw err
          }
        }
        return { path: resolvedPath, hash }
      } else {
        return { path: resolvedPath, hash: f.hash }
      }
    }).filter((f) => f.hash !== "")
  }

  private async cloneRemoteSource(
    log: LogEntry,
    remoteSourcesPath: string,
    repositoryUrl: string,
    hash: string,
    absPath: string
  ) {
    const git = this.gitCli(log, remoteSourcesPath)
    // Use `--recursive` to include submodules
    return git("clone", "--recursive", "--depth=1", `--branch=${hash}`, repositoryUrl, absPath)
  }

  // TODO Better auth handling
  async ensureRemoteSource({ url, name, log, sourceType }: RemoteSourceParams): Promise<string> {
    const remoteSourcesPath = join(this.gardenDirPath, this.getRemoteSourcesDirname(sourceType))
    await ensureDir(remoteSourcesPath)

    const absPath = join(this.gardenDirPath, this.getRemoteSourceRelPath(name, url, sourceType))
    const isCloned = await pathExists(absPath)

    if (!isCloned) {
      const entry = log.info({ section: name, msg: `Fetching from ${url}`, status: "active" })
      const { repositoryUrl, hash } = parseGitUrl(url)

      try {
        await this.cloneRemoteSource(log, remoteSourcesPath, repositoryUrl, hash, absPath)
      } catch (err) {
        entry.setError()
        throw new RuntimeError(`Downloading remote ${sourceType} failed with error: \n\n${err}`, {
          repositoryUrl: url,
          message: err.message,
        })
      }

      entry.setSuccess()
    }

    return absPath
  }

  async updateRemoteSource({ url, name, sourceType, log }: RemoteSourceParams) {
    const absPath = join(this.gardenDirPath, this.getRemoteSourceRelPath(name, url, sourceType))
    const git = this.gitCli(log, absPath)
    const { repositoryUrl, hash } = parseGitUrl(url)

    await this.ensureRemoteSource({ url, name, sourceType, log })

    const entry = log.info({ section: name, msg: "Getting remote state", status: "active" })
    await git("remote", "update")

    const remoteCommitId = getCommitIdFromRefList(await git("ls-remote", repositoryUrl, hash))
    const localCommitId = getCommitIdFromRefList(await git("show-ref", "--hash", hash))

    if (localCommitId !== remoteCommitId) {
      entry.setState(`Fetching from ${url}`)

      try {
        await git("fetch", "--depth=1", "origin", hash)
        await git("reset", "--hard", `origin/${hash}`)
        // Update submodules if applicable (no-op if no submodules in repo)
        await git("submodule", "update", "--recursive")
      } catch (err) {
        entry.setError()
        throw new RuntimeError(`Updating remote ${sourceType} failed with error: \n\n${err}`, {
          repositoryUrl: url,
          message: err.message,
        })
      }

      entry.setSuccess("Source updated")
    } else {
      entry.setSuccess("Source already up to date")
    }
  }

  /**
   * Replicates the `git hash-object` behavior. See https://stackoverflow.com/a/5290484/3290965
   */
  async hashObject(path: string) {
    const info = await stat(path)
    const stream = new PassThrough()
    const output = hasha.fromStream(stream, { algorithm: "sha1" })
    stream.push(`blob ${info.size}\0`)
    createReadStream(path).pipe(stream)
    return output
  }

  private async getSubmodules(gitRoot: string) {
    const submodules: Submodule[] = []
    const gitmodulesPath = join(gitRoot, ".gitmodules")

    if (await pathExists(gitmodulesPath)) {
      const parsed = await parseGitConfig({ cwd: gitRoot, path: ".gitmodules" })

      for (const [key, spec] of Object.entries(parsed || {}) as any) {
        if (!key.startsWith("submodule")) {
          continue
        }
        spec.path && submodules.push(spec)
      }
    }

    return submodules
  }
}
