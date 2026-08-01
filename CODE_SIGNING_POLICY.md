# Code Signing Policy

## Current status

Nova Display Controller intends to use free code signing provided by [SignPath.io](https://about.signpath.io), with a certificate issued to [SignPath Foundation](https://signpath.org), subject to application review and approval.

The project has not yet been accepted by SignPath Foundation. Until approval and CI integration are complete, Preview release artifacts are unsigned and must be labeled as such on their GitHub Release page. A published binary must not be described as SignPath-signed unless its Authenticode signature has been verified.

## Source and build integrity

- The canonical source repository is [xiamuyifeng/nova-display-controller](https://github.com/xiamuyifeng/nova-display-controller).
- Unsigned Preview artifacts must identify their exact source commit and publish a SHA-256 checksum.
- SignPath signing candidates must be produced from a tagged commit by the repository's approved automated GitHub Actions workflow.
- Signing credentials are never stored in the repository or distributed to maintainers.
- Every signing request requires manual approval after the source revision, build result, product name, and product version have been checked.
- Third-party binaries are not signed as if they were authored by this project.

## Team roles

The project currently has one maintainer, so the trusted roles are held by the same repository owner:

- Committer and reviewer: [xiamuyifeng](https://github.com/xiamuyifeng)
- Signing approver: [xiamuyifeng](https://github.com/xiamuyifeng)

Changes proposed by external contributors require maintainer review before merge. Direct maintainer changes are treated as trusted-author changes. Access to GitHub and SignPath must use multi-factor authentication.

## Privacy

See the project [Privacy Policy](./PRIVACY.md). Nova Display Controller does not transfer information to other networked systems unless specifically requested by the user or the person installing or operating it.

## 中文说明

本项目计划申请 SignPath Foundation 的免费开源代码签名服务，但目前尚未获批。申请和自动构建签名完成前，GitHub Releases 中的 Preview 安装包必须明确标注为“未签名”。只有通过 Authenticode 验证的产物才能声明为 SignPath 签名版本。
