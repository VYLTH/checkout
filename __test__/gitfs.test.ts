// gitfs.ts pulls in blacksmith-cache for the auth header; stub its gRPC
// dependencies the same way blacksmith-cache.test.ts does.
jest.mock('@connectrpc/connect', () => ({
  createClient: jest.fn(),
  ConnectError: class ConnectError extends Error {},
  Code: {Aborted: 'ABORTED'}
}))
jest.mock('@connectrpc/connect-node', () => ({
  createGrpcTransport: jest.fn()
}))
jest.mock(
  '@buf/blacksmith_vm-agent.connectrpc_es/stickydisk/v1/stickydisk_connect',
  () => ({StickyDiskService: {}})
)

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {execFileSync} from 'child_process'
import * as gitfs from '../src/gitfs'

const settings = (
  overrides: Partial<gitfs.EligibilitySettings> = {}
): gitfs.EligibilitySettings => ({
  ref: 'refs/heads/main',
  commit: '',
  submodules: false,
  lfs: false,
  sparseCheckout: [],
  filter: undefined,
  dissociate: false,
  repositoryPath: path.join(os.tmpdir(), 'gitfs-test-does-not-exist'),
  ...overrides
})

const ctx: gitfs.EligibilityContext = {
  mirrorPath: '/mnt/git-mirror/owner-repo.git',
  platform: 'linux',
  inContainer: false
}

describe('isGitfsRequested', () => {
  it('is driven by BLACKSMITH_USE_GITFS=true only', () => {
    expect(gitfs.isGitfsRequested({})).toBe(false)
    expect(gitfs.isGitfsRequested({BLACKSMITH_USE_GITFS: 'false'})).toBe(false)
    expect(gitfs.isGitfsRequested({BLACKSMITH_USE_GITFS: 'TRUE'})).toBe(false)
    expect(gitfs.isGitfsRequested({BLACKSMITH_USE_GITFS: 'true'})).toBe(true)
  })
})

describe('gitfsIneligibilityReason', () => {
  it('accepts the plain linux + mirror case', () => {
    expect(gitfs.gitfsIneligibilityReason(settings(), ctx)).toBeNull()
    expect(
      gitfs.gitfsIneligibilityReason(
        settings({ref: '', commit: 'a'.repeat(40)}),
        ctx
      )
    ).toBeNull()
  })

  it('needs a mounted mirror on a linux runner outside a container', () => {
    expect(
      gitfs.gitfsIneligibilityReason(settings(), {...ctx, mirrorPath: null})
    ).toMatch(/mirror/)
    expect(
      gitfs.gitfsIneligibilityReason(settings(), {...ctx, platform: 'darwin'})
    ).toMatch(/linux/)
    expect(
      gitfs.gitfsIneligibilityReason(settings(), {...ctx, inContainer: true})
    ).toMatch(/container/)
  })

  it('leaves features the fetch path implements to the fetch path', () => {
    expect(
      gitfs.gitfsIneligibilityReason(settings({submodules: true}), ctx)
    ).toMatch(/submodules/)
    expect(gitfs.gitfsIneligibilityReason(settings({lfs: true}), ctx)).toMatch(
      /lfs/
    )
    expect(
      gitfs.gitfsIneligibilityReason(settings({sparseCheckout: ['src']}), ctx)
    ).toMatch(/sparse/)
    expect(
      gitfs.gitfsIneligibilityReason(settings({filter: 'blob:none'}), ctx)
    ).toMatch(/filter/)
    expect(
      gitfs.gitfsIneligibilityReason(settings({dissociate: true}), ctx)
    ).toMatch(/dissociate/)
    expect(
      gitfs.gitfsIneligibilityReason(settings({ref: '', commit: ''}), ctx)
    ).toMatch(/ref or commit/)
  })

  it('does not mount over an existing repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitfs-elig-'))
    try {
      fs.mkdirSync(path.join(dir, '.git'))
      expect(
        gitfs.gitfsIneligibilityReason(settings({repositoryPath: dir}), ctx)
      ).toMatch(/already contains/)
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })
})

describe('mirrorRevisionCandidates', () => {
  const sha = 'b'.repeat(40)

  it('prefers the commit and keeps the ref it belongs to', () => {
    expect(gitfs.mirrorRevisionCandidates('refs/heads/main', sha)).toEqual([
      {rev: `${sha}^{commit}`, mirrorRef: 'refs/heads/main', kind: 'branch'}
    ])
    expect(gitfs.mirrorRevisionCandidates('refs/pull/42/merge', sha)).toEqual([
      {rev: `${sha}^{commit}`, mirrorRef: 'refs/pull/42/merge', kind: 'pull'}
    ])
    expect(gitfs.mirrorRevisionCandidates('', sha)).toEqual([
      {rev: `${sha}^{commit}`, mirrorRef: '', kind: 'commit'}
    ])
    // An unqualified ref alongside a commit does not name a mirror ref.
    expect(gitfs.mirrorRevisionCandidates('main', sha)).toEqual([
      {rev: `${sha}^{commit}`, mirrorRef: '', kind: 'other'}
    ])
  })

  it('peels qualified refs to commits', () => {
    expect(gitfs.mirrorRevisionCandidates('refs/tags/v1', '')).toEqual([
      {rev: 'refs/tags/v1^{commit}', mirrorRef: 'refs/tags/v1', kind: 'tag'}
    ])
  })

  it('tries an unqualified ref as a branch, then a tag', () => {
    expect(
      gitfs.mirrorRevisionCandidates('v1', '').map(c => c.mirrorRef)
    ).toEqual(['refs/heads/v1', 'refs/tags/v1'])
    expect(gitfs.mirrorRevisionCandidates('', '')).toEqual([])
  })
})

describe('mirrorFetchRefspecs', () => {
  const sha = 'c'.repeat(40)
  it('fetches qualified refs under their own name and bare commits by sha', () => {
    expect(gitfs.mirrorFetchRefspecs('refs/pull/7/merge', sha)).toEqual([
      `+${sha}:refs/pull/7/merge`
    ])
    expect(gitfs.mirrorFetchRefspecs('refs/heads/dev', '')).toEqual([
      '+refs/heads/dev:refs/heads/dev'
    ])
    expect(gitfs.mirrorFetchRefspecs('', sha)).toEqual([sha])
    expect(gitfs.mirrorFetchRefspecs('dev', sha)).toEqual([sha])
    expect(gitfs.mirrorFetchRefspecs('dev', '')).toEqual([
      '+refs/heads/dev*:refs/heads/dev*',
      '+refs/tags/dev*:refs/tags/dev*'
    ])
  })
})

// End-to-end against a real mirror and the gitfs binary (skipped when gitfs
// is not on PATH): mount, give the workspace its .git through the mount, and
// check git is usable before and after the swap to the native tree.
const hasGitfs = ((): boolean => {
  try {
    execFileSync('gitfs', ['--help'], {stdio: 'ignore'})
    return true
  } catch {
    return false
  }
})()

const describeE2E =
  hasGitfs && process.platform === 'linux' ? describe : describe.skip

describeE2E('gitfs mount of a --mirror clone', () => {
  jest.setTimeout(120_000)
  let root: string
  let mirror: string
  let workspace: string
  const git = (cwd: string, args: string[]): string =>
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t'
      }
    }).trim()

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitfs-e2e-'))
    const upstream = path.join(root, 'upstream')
    fs.mkdirSync(upstream)
    git(upstream, ['init', '-q', '-b', 'main'])
    fs.mkdirSync(path.join(upstream, 'src'))
    fs.writeFileSync(path.join(upstream, 'src', 'a.txt'), 'a\n')
    fs.writeFileSync(path.join(upstream, 'README'), 'hi\n')
    git(upstream, ['add', '.'])
    git(upstream, ['commit', '-q', '-m', 'one'])
    git(upstream, ['tag', 'v1'])
    fs.writeFileSync(path.join(upstream, 'src', 'b.txt'), 'b\n')
    git(upstream, ['add', '.'])
    git(upstream, ['commit', '-q', '-m', 'two'])
    mirror = path.join(root, 'owner-repo.git')
    execFileSync('git', ['clone', '-q', '--mirror', upstream, mirror])
    workspace = path.join(root, 'work', 'repo')
    fs.mkdirSync(workspace, {recursive: true})
  })

  afterAll(async () => {
    if (workspace) {
      await gitfs.teardown(workspace, mirror)
    }
    fs.rmSync(root, {recursive: true, force: true})
  })

  it('serves the branch tip with a working .git from the first command', async () => {
    const binary = await gitfs.findBinary()
    expect(binary).not.toBeNull()
    const revision = await gitfs.resolveInMirror(
      mirror,
      gitfs.mirrorRevisionCandidates('refs/heads/main', '')
    )
    expect(revision).toEqual({
      sha: git(mirror, ['rev-parse', 'refs/heads/main']),
      mirrorRef: 'refs/heads/main',
      kind: 'branch'
    })

    await gitfs.mount(binary!, mirror, revision!.sha, workspace)
    expect(fs.readFileSync(path.join(workspace, 'src', 'b.txt'), 'utf8')).toBe(
      'b\n'
    )

    git(workspace, ['init', '-q'])
    fs.mkdirSync(path.join(workspace, '.git', 'objects', 'info'), {
      recursive: true
    })
    fs.writeFileSync(
      path.join(workspace, '.git', 'objects', 'info', 'alternates'),
      `${mirror}/objects\n`
    )
    git(workspace, ['remote', 'add', 'origin', mirror])
    execFileSync('git', [
      '-C',
      workspace,
      'fetch',
      '-q',
      '--no-tags',
      mirror,
      '+refs/heads/*:refs/remotes/origin/*',
      '+refs/tags/*:refs/tags/*'
    ])
    await gitfs.pointWorkspaceAt(workspace, 'refs/heads/main', revision!)

    expect(git(workspace, ['rev-parse', 'HEAD'])).toBe(revision!.sha)
    expect(git(workspace, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main')
    expect(git(workspace, ['rev-parse', 'refs/remotes/origin/main'])).toBe(
      revision!.sha
    )
    expect(git(workspace, ['status', '--porcelain'])).toBe('')
    expect(git(workspace, ['log', '--oneline']).split('\n')).toHaveLength(2)

    // Wait for the swap: the workspace path becomes a plain directory.
    const deadline = Date.now() + 60_000
    while (fs.lstatSync(workspace).isSymbolicLink() && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50))
    }
    expect(fs.lstatSync(workspace).isDirectory()).toBe(true)
    expect(git(workspace, ['status', '--porcelain'])).toBe('')
    expect(git(workspace, ['rev-parse', 'HEAD'])).toBe(revision!.sha)
    expect(fs.readFileSync(path.join(workspace, 'src', 'a.txt'), 'utf8')).toBe(
      'a\n'
    )

    // The mirror itself is untouched.
    expect(
      fs.existsSync(path.join(mirror, 'objects', 'info', 'alternates'))
    ).toBe(false)
  })

  it('refuses a non-empty mountpoint', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'nonempty-'))
    fs.writeFileSync(path.join(dir, 'x'), '')
    await expect(gitfs.mount('gitfs', mirror, 'HEAD', dir)).rejects.toThrow(
      /not empty/
    )
  })
})
