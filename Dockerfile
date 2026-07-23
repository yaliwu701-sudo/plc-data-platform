# PLC 数据采集与管理平台 - Docker 镜像
FROM node:20-alpine

# 安装构建工具（用于可选的原生驱动：node-snap7 / modbus-serial）
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
# 安装全部依赖，包含可选的原生驱动（失败不阻断镜像构建）
RUN npm install --include=optional || npm install

COPY . .

# 数据持久化目录（运行时挂载卷）
ENV DATA_DIR=/app/data
ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000

CMD ["node", "server/index.js"]
