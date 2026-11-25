FROM node:22-alpine AS dev
ARG APP
WORKDIR /app/${APP}
COPY ${APP}/package*.json ./
RUN npm ci
COPY shared/ /app/shared/
COPY ${APP}/ ./
CMD ["npm","run","dev","--","--host","0.0.0.0"]

FROM dev AS build
RUN npm run build

FROM nginx:alpine
ARG APP
ARG APP_PORT
ENV APP=${APP} APP_PORT=${APP_PORT}
COPY app.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/${APP}/dist/ /usr/share/nginx/html/${APP}/
