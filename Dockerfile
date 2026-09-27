FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# The bot keeps state.json next to src/. Point it at /data so it lives on a volume
# and survives rebuilds; restarts then edit the same Discord messages.
RUN mkdir /data && chown node:node /data && ln -s /data/state.json /app/state.json

USER node
CMD ["node", "src/bot.js"]
