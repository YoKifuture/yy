# 烟机降噪选型与仿真 Agent

面向吸油烟机声学研发的无流方案筛选工具。输入目标频段或导入两列频谱，根据安装空间和工艺约束生成候选。参赛算例采用 600–1200 Hz 和 250 × 320 × 15 mm 的教学式包络，最小孔径 0.5 mm、安装预留 2 mm 和纤维流阻率 20,000 Pa·s/m² 为演示假设。

## 运行与分享

- **评委网页**由 GitHub Pages 托管 `dist/`。浏览器本地执行频谱分析、对话规则和工程选型。页面可切换到 COMSOL 6.4 预求解曲线。
- **完整模式**启动 Node 服务后使用真实 Codex 和本机 COMSOL。评委终端只需要浏览器。运行节点需要可用的 Codex 环境和 COMSOL Acoustics Module 许可证。

```powershell
$env:HOOD_CODEX_COMMAND = (Get-Command codex).Source
$env:HOOD_COMSOL_BIN = 'D:/COMSOL/Multiphysics/bin/win64'
$env:HOOD_PORT = '8772'
node server/index.mjs
```

打开 `http://127.0.0.1:8772/`。Node 需要 22 或更新版本，无需安装项目依赖。Codex 使用当前运行账户已授权的 CLI 会话。在空的任务工作目录内运行，只接收用户当前输入和必要的条件 JSON，输出符合固定模式的数据，编排器只调用预定义工程工具。频谱原始 CSV 留在浏览器。模型推断出的额外条件须经用户确认，COMSOL 任务由用户在网页核对后提交。

服务默认监听本机。跨设备部署时，可由公司批准的 HTTPS 入口转发，并负责评委鉴权、并发和运行配额。每个 COMSOL 节点一次执行一项任务，重启后任务索引需要重新建立。Codex 出错时页面显示本地规则回退。没有设置 `HOOD_COMSOL_BIN` 时仍可使用解析初筛和预求解曲线。替换为食神 AI 时，接入实际模型或平台工具协议并保留统一输入与结果校核。

## 可复核的案例

| 模板 | 默认测试边界 | COMSOL 结果 |
| --- | --- | --- |
| 浅背腔微穿孔板 | 0.5 mm 孔、1 mm 板、0.6% 开孔率、12 mm 刚性背腔 | 600–1200 Hz，41 点，平均正入射吸声系数 0.661 |
| Miki 多孔纤维层 | 刚性背衬，13 mm，20,000 Pa·s/m² | 同一频段与采样，平均 0.142 |
| Delany–Bazley 多孔纤维层 | 同一背衬、厚度和流阻率 | 同一频段与采样，平均 0.146 |
| 侧支亥姆霍兹 | 另一组风道样例，空气域二维平面模态端口 | 150–950 Hz 两模型各 161 点，基准与侧支腔比较 |

薄型模块输出正入射吸声系数，侧支风道输出部件传声损失。模型假设无平均流。装机噪声改善需要结合声源和传递路径，在整机上复核。微穿孔板采用 Maa 型近似局部反应阻抗，未解析各孔、板弯曲、堵孔或油污。经验多孔模型用于适用范围内的高孔隙率纤维材料。侧支模型采用刚壁和单平面模态，未计热黏性损失。页面对卷曲通道、消声器和声学黑洞提供适用性说明。

## 验收

1. 打开网页，确认默认频段、包络和两组正入射曲线。切换 Delany–Bazley 后查看对应曲线。
2. 输入“频段改为 700–1100 Hz，厚度改为 12 mm”，确认参数与候选同步变化，曲线来源切换为当前参数的解析估算。
3. 将最小孔径改为 2 mm，检查微穿孔板筛除。导入一份适用频段内的双列频谱，检查识别主峰、回填频段与手工编辑。
4. 本机完整模式选择薄型候选运行 COMSOL，获取状态和下载 MPH 与 CSV。浏览器静态模式展示预求解证据。
5. 切到侧支风道，检查原样例以及 380–460 Hz 目标频段内结果。分别运行 `node --test` 和 `node --check server/index.mjs`。

## 工程实现

- `dist/agent.mjs` 管理多轮工况、缺项和候选路由。`dist/engineering.mjs` 处理频谱和侧支方案。`dist/absorbers.mjs` 计算吸声系数并搜索尺寸。
- `server/index.mjs` 提供应用 API。`server/codex.mjs` 调用 Codex CLI 并校验返回。`server/solver.mjs` 负责标量参数、队列、曲线验收与文件下载。
- `comsol/HoodAcoustics.java` 生成、求解及保存可编辑模型。`comsol/run-sample.ps1` 执行 COMSOL 批处理，可在工作目录提供经白名单校验的 `job.properties`。
- `comsol/import-thin.mjs` 将微穿孔板、Miki 与 Delany–Bazley 的 41 点参考结果转换为页面数据，校验与解析表达的差异。`comsol/import-sample.mjs` 验证直管基准与侧支样例。

Creo 组件识别和任意论文自动复建属于后续集成。前者需要明确材料命名或 Creo 自定义属性约定、样件和导入许可，后者需要可追溯的参数和验证算例。实际食神服务、真实频谱和整机验证可按相同项目流程继续接入。

参考 [COMSOL 阻抗边界](https://doc.comsol.com/6.4/doc/com.comsol.help.aco/aco_ug_pressure.05.023.html)、[COMSOL 多孔声学模型](https://doc.comsol.com/6.4/doc/com.comsol.help.aco/aco_ug_pressure.05.185.html)、[Miki 论文](https://doi.org/10.1250/ast.11.19) 和 [Codex CLI 平台文档](https://developers.openai.com/blog/codex-as-a-platform)。
