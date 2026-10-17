import { requestUrl } from 'obsidian'
import type { GithubRequestFunc } from './fsGithub'

/**
 * GitHub's API through Obsidian's `requestUrl`, which avoids CORS on desktop
 * and phone. `throw: false`, so the GitHub fs reads every status itself.
 */
export const obsidianGithubRequest: GithubRequestFunc = async (req) => {
  const res = await requestUrl({
    url: req.url,
    method: req.method,
    headers: req.headers,
    body: req.body,
    throw: false,
  })
  let json: any = undefined
  try {
    json = res.json
  } catch (e) {
    // a reply with no JSON body
  }
  return { status: res.status, headers: res.headers, json }
}
