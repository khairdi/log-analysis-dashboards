# AWS Log Analytics Dashboard

A local analytics dashboard for AWS CloudFront CDN logs and AWS WAF firewall logs. Matches the look and feel of Cloudflare's analytics UI.

## Features

**CloudFront Analytics**
- Requests over time (grouped by country, path, host, status code, cache status, referer)
- Bandwidth, cache hit rate, top paths, referrers, browsers, OS, data centers, ASNs
- Sampled request logs with expandable detail rows

**WAF Security Analytics**
- Action breakdown (ALLOW / BLOCK / COUNT / CAPTCHA / CHALLENGE)
- Top rules, rule types, rule groups, WAF labels, JA3/JA4 fingerprints
- Client IP lookup, user agent parsing, country breakdown
- Sampled request logs with full WAF decision details

**Filtering**
Click any metric row to filter, or use the **+ Add filter** button for advanced operators:

| Operator | Symbol | Notes |
|---|---|---|
| equals / does not equal | `=` / `≠` | Exact match |
| contains / does not contain | `~` / `!~` | Substring |
| starts with / does not start with | `^` / `!^` | Prefix |
| ends with / does not end with | `$` / `!$` | Suffix |
| is in / is not in | `∈` / `∉` | Comma-separated list |

Multiple filters stack (AND logic). All charts and metric tables update live.

## Prerequisites

- Node.js 18+ (Vite 5 requires it)
- AWS credentials configured in `~/.aws/` (for S3 access)

## Quick start — local dev

```bash
npm install
npm run dev
```

Opens at **http://localhost:5173**. The Express backend runs on port 3001 and is proxied automatically.

To use local `.log` / `.gz` files only (no S3), run just the Vite server:

```bash
npm run dev:vite
```

## Docker — local machine

Mounts `~/.aws` so the container inherits your local AWS credentials:

```bash
docker compose up --build
```

Opens at **http://localhost:8192**.

## Docker — EC2 (IAM instance role)

No credential mounting needed; the SDK picks up the instance role automatically:

```bash
# On the EC2 instance
docker compose -f docker-compose.ec2.yml up -d
```

Opens on port 80. Set `AWS_REGION` in the environment if your buckets are not in `ap-southeast-1`.

## S3 URI format

Paste an S3 URI into the picker — full paths are accepted and stripped automatically:

```
s3://my-bucket/AWSLogs/123456789/CloudFront/ap-southeast-1/DIST_ID/
s3://aws-waf-logs-my-account/AWSLogs/123456789/WAFLogs/cloudfront/my-webacl/
```

The dashboard auto-detects available dates and lets you pick which ones to load.

## Commands

```bash
npm run dev          # Vite + Express (both servers)
npm run dev:vite     # Vite only
npm run dev:server   # Express only
npm run build        # Type-check + production bundle
npx tsc --noEmit     # Type-check without building
```
