# 声学研发工作台

用于吸油烟机的无平均流部件级分析。导入噪声频谱或设置目标频段，填写安装包络与加工条件，计算候选结构。工况可以导出为 JSON，供复用或跨设备导入。

## 在线工作区

[打开声学研发工作台](https://yokifuture.github.io/yy/)

GitHub Pages 托管浏览器工作区。频谱 CSV 在浏览器中解析。在线工作区可完成参数校核、解析选型和报告导出。Codex 对话和实时 COMSOL 根据服务状态启用。

## 启动完整服务

Windows 节点需要 Node.js 22 或更新版本，以及有权限的 Codex CLI 和 COMSOL Acoustics Module。项目运行无需安装 npm 依赖。

```powershell
$env:HOOD_CODEX_COMMAND = (Get-Command codex).Source
$env:HOOD_COMSOL_BIN = 'D:/COMSOL/Multiphysics/bin/win64'
$env:HOOD_PORT = '8773'
node server/index.mjs
```

在运行节点打开 `http://127.0.0.1:8773/`。Codex 提取结构化工况，工程程序校核参数并运行模板。模型推断的额外值须经用户确认。COMSOL 执行队列一次处理一项任务，返回求解状态、曲线和可编辑 MPH 文件。

跨网络运行时，将固定 HTTPS 入口反向代理到同一个 Node 服务。设置 `HOOD_PUBLIC_HOST` 为外部域名并保留请求的 Host。将随机生成的访问口令通过运行环境变量 `HOOD_ACCESS_TOKEN` 注入，用户名为 `acoustic`。服务在该域名上鉴权，支持分享不含口令的网址。Node 服务可继续只监听回环地址。GitHub Pages 地址可独立保留为在线工程选型入口。

## 工程工作流

- 吸声模块以正入射吸声系数对比浅背腔微穿孔板和刚性背衬多孔纤维材料。多孔材料可用 Miki 或 Delany–Bazley 模型，需要由用户输入流阻率。
- 风道消声根据主风道与侧挂空间筛选侧支结构。当前 COMSOL 模板计算侧支亥姆霍兹和相同风道的空直管基准。压力声学模型采用二维、刚壁、单平面模态。
- `comsol/HoodAcoustics.java` 根据经校核的数值建立并保存模型。运行 `node --test` 核对公式、参数校验和参考曲线。

模型的指标与边界随结果显示。卷曲结构、声学黑洞、Creo 识别和论文复建仍需相应的工程模型与案例验证。

参考 [COMSOL 阻抗边界](https://doc.comsol.com/6.4/doc/com.comsol.help.aco/aco_ug_pressure.05.023.html)、[COMSOL 多孔声学模型](https://doc.comsol.com/6.4/doc/com.comsol.help.aco/aco_ug_pressure.05.185.html)、[Miki 论文](https://doi.org/10.1250/ast.11.19)。
