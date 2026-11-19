import { describe, expect, test } from 'bun:test'
import { parseHash, hrefForProject } from './routes'

describe('parseHash', () => {
  test('#/projects/<name> parses the project and leaves adw/phase null', () => {
    expect(parseHash('#/projects/docs')).toEqual({ project: 'docs', adwId: null, phaseId: null })
  })

  test('a project name with spaces is decoded', () => {
    expect(parseHash('#/projects/updating%20the%20factory')).toEqual({
      project: 'updating the factory',
      adwId: null,
      phaseId: null,
    })
  })

  test('a project name with an encoded slash stays one segment', () => {
    expect(parseHash('#/projects/a%2Fb')).toEqual({ project: 'a/b', adwId: null, phaseId: null })
  })

  test('hrefForProject round-trips through parseHash, slashes and spaces included', () => {
    for (const name of ['docs', 'a/b', 'my project', 'a/b c']) {
      expect(parseHash(hrefForProject(name)).project).toBe(name)
    }
  })

  test('#/<adw_id> still parses as a session with no project', () => {
    expect(parseHash('#/docs-readme-trying-this-out')).toEqual({
      project: null,
      adwId: 'docs-readme-trying-this-out',
      phaseId: null,
    })
  })

  test('#/<adw_id>/<phase> still parses both parts', () => {
    expect(parseHash('#/abc123/plan')).toEqual({ project: null, adwId: 'abc123', phaseId: 'plan' })
  })

  test('the root hash is all null', () => {
    expect(parseHash('#/')).toEqual({ project: null, adwId: null, phaseId: null })
    expect(parseHash('')).toEqual({ project: null, adwId: null, phaseId: null })
  })
})
