FROM node:8-stretch

COPY . /app

WORKDIR "/app"

RUN npm install

ENTRYPOINT ["node", "cleaner.js"]
