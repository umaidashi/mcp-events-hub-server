# The hub and the mock service run from the source as is: Node 24 runs .ts and they have no runtime
# dependencies. The client adds pi and installs this repository into it as a pi package.
FROM node:24-slim AS base
WORKDIR /app
RUN mkdir -p /data .data && chown node:node /data .data

FROM base AS app
COPY . .
USER node
CMD ["node", "src/node.ts"]

FROM base AS client
ARG PI_VERSION=1.3.0
# A TLS-intercepting proxy needs its CA for the npm registry; compose passes it as the extra-ca secret.
RUN --mount=type=secret,id=extra-ca \
    if [ -s /run/secrets/extra-ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra-ca; fi; \
    npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_VERSION} && npm cache clean --force
COPY . .
USER node
ENV PI_CODING_AGENT_DIR=/home/node/.pi/agent
RUN pi install /app
CMD ["pi"]
