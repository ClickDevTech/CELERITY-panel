# Celerity panel updater sidecar.
# Tiny, dependency-free Node service. Needs docker CLI + compose plugin to drive
# the host Docker daemon (via a mounted socket) and git for source-mode updates.
FROM node:22-alpine

RUN apk add --no-cache docker-cli docker-cli-compose git

# The project directory is a host bind mount owned by an arbitrary host user,
# while this container runs as root. Without safe.directory git >= 2.35 refuses
# every operation with "detected dubious ownership in repository".
RUN git config --system --add safe.directory '*'

WORKDIR /updater

COPY server.js ./

EXPOSE 8484

# Absolute path: compose sets working_dir to the mounted project dir (so docker
# compose runs there), which overrides the image WORKDIR - a relative entrypoint
# would then resolve against the project dir where no server.js exists.
CMD ["node", "/updater/server.js"]
