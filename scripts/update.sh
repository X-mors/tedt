#!/bin/bash
set -e

echo "==> Pulling latest changes..."
git pull

echo "==> Installing dependencies..."
pnpm install --frozen-lockfile

echo "==> Pushing DB schema..."
pnpm --filter @workspace/db run push

echo "==> Building API server..."
pnpm --filter @workspace/api-server run build

echo "==> Building frontend..."
pnpm --filter @workspace/rigmarket run build

echo "==> Restarting API server..."
pm2 restart rigmarket-api

echo "==> Done."
