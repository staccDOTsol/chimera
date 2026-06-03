# Chimera unified host — clearnet feed + multi-tenant MCP (/mcp).
# Stateful: the body is in-memory and SSE streams are long-lived, so run ONE
# machine (horizontal scaling would split the body — see fly.toml / DEPLOY notes).
FROM node:24-alpine
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY src ./src
COPY web ./web
COPY SKILL.md ./SKILL.md

ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787
CMD ["node", "src/web.ts"]
