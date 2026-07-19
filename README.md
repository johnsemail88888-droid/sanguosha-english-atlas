# 三国杀英文图鉴

给持有中文实体牌的英语玩家使用：按中文牌图找到牌，再阅读完整英文效果、大白话打法、使用时机、实战例子与常见误区。

## 直接使用

- **网页版：** [打开三国杀英文图鉴](https://johnsemail88888-droid.github.io/sanguosha-english-atlas/)
- **macOS 桌面版：** [下载最新安装包](https://github.com/johnsemail88888-droid/sanguosha-english-atlas/releases/latest)

macOS 首次打开未签名的个人应用时，如果系统阻止启动，请在 Finder 中按住 Control 点击 App，选择“打开”，再确认一次。应用无需账号，牌图和说明均保存在本地。

## 收录范围

- 三国杀移动版：标准武将、界限突破、风、火、林、山、阴、雷及对应的十二名经典神将（112 名武将）
- 标准版与军争篇常用基本牌、锦囊牌、装备牌（43 种游戏牌）
- 不收录谋、势、魔等现代付费/超模扩展

每张武将牌包括官方中文技能原文、完整英文翻译、大白话打法、使用时机、实战例子和常见误区。支持中文名、英文名、中文技能名和英文技能内容搜索。

## 本地开发与打包

```bash
npm install
npm run validate:data
npm test
npm run build
npm run pack:mac
```

发布网页版：

```bash
npm run deploy:web
```

## 资料、版权与许可

武将技能、官方玩法提示和默认皮肤图来自[三国杀移动版官网](https://www.sanguosha.cn/hero-list.html)，版权归其权利人所有。游戏牌图取自开源项目 [QSanguosha-v2](https://github.com/Mogara/QSanguosha-v2)，遵循其 GPLv3 与 MCFR 非商业限制，详见 [`licenses/`](licenses/)。

本项目仅供个人学习、桌游辅助和非商业使用，不隶属于游卡桌游。英文说明为依据公开中文规则制作的辅助翻译；遇到赛事裁定时，以当前官方规则为准。项目自身代码的使用条件见 [LICENSE.md](LICENSE.md)，第三方图片不由本项目重新授权。
