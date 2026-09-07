# Dockerfile
#
# Runs the e-visa Telegram bot in a container.
#
# The bot drives a real Chromium against a live form, so the image is built on
# Playwright's own, which carries the browser and the system libraries it needs
# already matched to the client version. Installing Chromium onto a plain Node
# image means chasing that library list by hand every time either side moves.
#
# The version here must match the `playwright` dependency in package.json: the
# client refuses to drive a browser build it does not recognise.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

ENV NODE_ENV=production

# The passport's machine-readable zone is read with the tesseract command,
# which the browser image does not carry. Without it every photo is taken for a
# portrait, and the form gets no passport at all.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tesseract-ocr \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies are installed from the lockfile alone, before the source is
# copied, so editing a source file does not invalidate the cached install.
COPY package.json package-lock.json ./

# `--ignore-scripts` skips Playwright's browser download: the base image already
# has one, and fetching a second copy would add hundreds of megabytes. `sharp`
# and `@napi-rs/canvas` ship prebuilt binaries, so neither needs a build step.
RUN npm ci --omit=dev --ignore-scripts

COPY src ./src
COPY bin ./bin

# The bot writes logs and the documents it is sent under one directory, so a
# volume mounted here is all that is needed to inspect or persist them. Left
# unmounted, they stay inside the container and go when it is removed.
ENV EVISA_BOT_HOME=/data
ENV EVISA_BOT_LOG=/data/evisa-bot-debug.log
ENV TMPDIR=/data/tmp
RUN mkdir -p /data/tmp && chown -R pwuser:pwuser /data

# Playwright's image provides this unprivileged user; running the browser as
# root is refused by Chromium's sandbox and is worth avoiding regardless.
USER pwuser

# No health check port to expose: the bot polls Telegram outbound and listens
# on nothing.
CMD ["node", "src/evisa-bot-run.mjs"]
