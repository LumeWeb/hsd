FROM node:24-alpine AS base
WORKDIR /opt/hsd
RUN apk add --no-cache bash unbound-dev gmp-dev
COPY package.json /opt/hsd

# Install build dependencies and compile.
FROM base AS build
RUN apk add --no-cache g++ gcc make python3 git
RUN npm install --omit=dev

# handover plugin: HNSDNS/handover @ nsec-ds. Its peers resolve against
# hsd's node_modules. The sources are plain TypeScript relying on Node 24
# type stripping, and Node won't strip types for .ts under a node_modules
# directory, so it can't go in /opt/hsd/node_modules directly. It lives next
# to hsd instead; the final stage symlinks it into node_modules so `loader:
# require` can resolve the module name `handover`, while realpath resolution
# keeps TS stripping happy.
RUN git clone --depth 1 https://github.com/HNSDNS/handover.git /opt/hsd/handover \
    && cd /opt/hsd/handover \
    && npm install --omit=dev

FROM base
ENV PATH="${PATH}:/opt/hsd/bin:/opt/hsd/node_modules/.bin"
COPY --from=build /opt/hsd/node_modules /opt/hsd/node_modules/
COPY --from=build /opt/hsd/handover /opt/hsd/handover/
RUN ln -s ../handover /opt/hsd/node_modules/handover
COPY bin /opt/hsd/bin/
COPY lib /opt/hsd/lib/
ENTRYPOINT ["hsd"]
