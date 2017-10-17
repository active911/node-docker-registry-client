FROM node:8-stretch

COPY . /app

WORKDIR "/app"

RUN npm install

RUN npm install node-cron

ENTRYPOINT ["node", "main.js"]
