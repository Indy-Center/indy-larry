FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# The bot keeps state.json, notify.json and ironmic.json next to src/. Point them at /data so they live on a volume
# and survive rebuilds; restarts then edit the same Discord messages and keep role timers running.
RUN mkdir /data && chown node:node /data \
 && ln -s /data/state.json /app/state.json \
 && ln -s /data/notify.json /app/notify.json \
 && ln -s /data/ironmic.json /app/ironmic.json

USER node
CMD ["node", "src/bot.js"]
