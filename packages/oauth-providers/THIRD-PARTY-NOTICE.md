# Third-party notice

This package derives in part from two MIT-licensed projects. Their license
terms are reproduced below as required for copies and substantial portions of
the Software.

## werifu/dsh-oai-oauth

The ChatGPT provider modules (adapter, auth, catalog, discovery, oauth,
login, serialize) and the shared transport derive in substantial part from
<https://github.com/werifu/dsh-oai-oauth>, ported to this repository's build
layout and adapted to the DSH 0.1.5-rc API surface
(`ToolCallId` brand rename, `ctx.settings.installSection`, client Remote wire,
credential-seam token storage in place of the Codex CLI `auth.json`; now one
provider module of the multi-provider `dsh-oauth-providers` package).

MIT License

Copyright (c) 2026 werifu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## pi-ai (`@earendil-works/pi-ai`)

The OAuth protocol module (`src/providers/chatgpt/oauth.ts`) adapts the `openai-codex` flow —
PKCE S256 authorization URL shape, loopback callback server on
`127.0.0.1:1455`, the manual paste fallback and its input grammar, token
exchange/refresh request bodies, and the account-id JWT claim path — from
`@earendil-works/pi-ai` 0.85.1 (MIT, © Mario Zechner,
<https://github.com/earendil-works/pi>, files `dist/auth/oauth/openai-codex.js`
and `dist/auth/oauth/pkce.js`).

MIT License

Copyright (c) Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
