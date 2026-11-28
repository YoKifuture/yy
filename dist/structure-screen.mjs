import {averageAbsorption, fitSlitAbsorbers} from './slit-model.mjs';

const round = value => Number(value.toFixed(1));
const positive = value => Number.isFinite(value) && value > 0;

function pathOptions(input, mode, target) {
  const required = 343000 / (4 * target);
  const names = [['quarter-wave', '四分之一波长直通道'], ['coiled', '卷曲迷宫（单 U 形）']];
  const allowance = mode === 'thin' ? input.reserve : input.allowance;
  const reserveName = mode === 'thin' ? '安装预留' : '轴向接口占用和风道净高';
  const length = mode === 'thin' ? input.length : input.length - allowance;
  const depth = mode === 'thin' ? input.height - allowance : input.height - input.duct;
  const {width, min, wall} = input;
  const properties = {targetHz: round(target), acousticPathMM: round(required)};
  const base = `中心约 ${round(target)} Hz，理想四分之一波长声程约 ${round(required)} mm。`;
  if (!Number.isFinite(allowance) || allowance < 0 || (mode === 'duct' && !positive(input.duct))) {
    return names.map(([id, name]) => ({id, name, status: 'pending', reason: base + `请补充${reserveName}以核算净包络。`, properties}));
  }
  if (length <= 0 || depth <= 0) {
    return names.map(([id, name]) => ({id, name, status: 'blocked', reason: '扣除风道或安装预留后，净空间不足。', properties}));
  }
  if (!positive(min) || !positive(wall)) {
    return names.map(([id, name]) => ({id, name, status: 'pending', reason: base + '填写最小净开口和盖板、隔墙等厚值后校核。', properties}));
  }

  const span = Math.max(length, width);
  const lateral = Math.min(length, width);
  const internalHeight = depth - 2 * wall;
  const pitch = min + wall;
  // Straight run between end-wall clearances. The folded template uses two
  // equal legs and one right-angle return with centerline separation pitch.
  const directCapacity = span - 2 * wall;
  const foldedLeg = (required - pitch) / 2;
  const straightFits = internalHeight >= min && lateral >= min + 2 * wall && directCapacity >= required;
  const foldedFits = internalHeight >= min && lateral >= 2 * min + 3 * wall
    && foldedLeg >= min && foldedLeg + min <= directCapacity;
  const metric = (value, unit = 'mm') => round(value) + ' ' + unit;
  const clearance = `净包络 ${metric(length)} × ${metric(width)} × ${metric(depth)}。`;
  return [
    {id: names[0][0], name: names[0][1], status: straightFits ? 'geometry' : 'blocked', properties,
      reason: base + (straightFits ? `按净宽 ${metric(min)} 可沿长边布置。验证开口耦合与损耗后确定有效频带。`
        : clearance + `长边可用声程约 ${metric(Math.max(0, directCapacity))}，或截面净空不足。`)},
    {id: names[1][0], name: names[1][1], status: foldedFits ? 'geometry' : 'blocked',
      properties: {...properties, legMM: round(foldedLeg), passageWidthMM: min, wallMM: wall},
      reason: base + (foldedFits ? `两条直段各约 ${metric(foldedLeg)}，按净宽 ${metric(min)}、壁厚 ${metric(wall)} 可布置。弯道和热黏性损耗待验证。`
        : clearance + '当前等宽双直段方案的转弯空间或截面净空不足。')},
  ];
}

export function recommendStructures(input, analysis, mode, profile) {
  const {low, high, length, width, height} = input;
  if (![low, high, length, width, height].every(positive) || high <= low) return null;
  const target = Math.sqrt(low) * Math.sqrt(high);
  if (!positive(target) || !Number.isFinite(343000 / (4 * target))) return null;
  const bandwidth = (high - low) / target;
  const weighting = profile?.low === low && profile.high === high ? profile : null;
  const slitDesigns = mode === 'thin' && !analysis.error ? fitSlitAbsorbers(input, weighting) : {};
  const metricName = weighting ? '频谱加权吸声系数' : '频带平均吸声系数';
  const estimate = item => `正入射${metricName} ${item.average.toFixed(3)}`;
  const paths = pathOptions(input, mode, target);
  const ductItems = analysis.items ?? [];
  const hr = mode === 'duct' && ductItems.find(item => item.id === 'helmholtz');
  const ductPanel = mode === 'duct' && ductItems.find(item => item.id === 'perforate');
  const panel = mode === 'thin' ? analysis.panel : ductPanel?.fit;
  const rankings = mode === 'thin' ? [
    ...(panel ? [{...panel, average: averageAbsorption(panel.series, weighting)}] : []),
    ...Object.values(slitDesigns),
  ].sort((a, b) => b.average - a.average) : [];
  const items = [
    {id: 'helmholtz', name: mode === 'thin' ? '亥姆霍兹共振单元' : '侧支亥姆霍兹',
      status: hr?.fit ? 'model' : hr ? 'blocked' : 'pending',
      reason: hr?.reason ?? (mode === 'thin' ? '针对窄带峰可用颈口与背腔调谐。薄型面板单元还需核对有效颈长、净腔容积和单元布置。'
        : '补齐风道高度、接口占用与最小开口后，可反算颈口和腔体。')},
    ...paths.map(item => {
      const design = slitDesigns[item.id];
      if (!design) return item;
      const g = design.geometry;
      return {...item, status: 'analytic',
        reason: `${estimate(design)}。按声程 ${round(g.pathMM)} mm、净缝高 ${round(g.gap)} mm、通道宽 ${round(g.breadth)} mm 布置 ${g.cells} 个单元。`,
        properties: g};
    }),
    {id: 'mpp', name: '微穿孔板与背腔', status: panel ? 'model' : positive(input.min) && !analysis.error ? 'blocked' : 'pending',
      reason: mode === 'duct' ? ductPanel?.reason ?? '补齐风道安装约束与最小开口后校核背腔。'
        : panel ? `${estimate(rankings.find(item => item.id === 'mpp'))}。核对孔径、板厚与背腔深度。` : analysis.panelIssue ?? '补齐安装预留与最小孔径后计算吸声曲线。'},
    {id: 'muffler', name: '扩张式消声器', status: 'pending',
      reason: '需提供进出口截面、可用扩张截面与腔长，才可估算无流传声损失。'},
    {id: 'abh', name: '结构声学黑洞（ABH）', status: 'conditional',
      reason: '适用于板壳弯曲振动主导的传递路径。需要结构振动证据、材料和可加工板厚。'},
  ];
  // Use the existing 27% relative-bandwidth cutoff to choose the order
  // of validation. A fit check supplies no absorption or TL prediction.
  const narrow = bandwidth < .27;
  const priority = mode === 'thin' ? rankings[0]?.id : (narrow && hr?.fit ? 'helmholtz' : panel ? 'mpp' : hr?.fit ? 'helmholtz' : null);
  const recommendation = items.find(item => item.id === priority);
  const available = items.filter(item => ['geometry', 'model'].includes(item.status));
  const summary = rankings.length
    ? `按${metricName}排序，当前候选中优先验证${recommendation.name}。已有 ${rankings.length} 种结构通过尺寸筛选并完成解析计算。`
    : recommendation
    ? `优先验证${recommendation.name}。` + (narrow
      ? `相对带宽 ${round(100 * bandwidth)}%，可先核对中心调谐及有效带宽。`
      : `相对带宽 ${round(100 * bandwidth)}%，下一步需核对目标带内传声损失。单个共振单元需分频点验证。`)
    : available.length ? `相对带宽 ${round(100 * bandwidth)}%。可布置的单频结构需验证多单元分频覆盖，再确定优先方案。`
      : '当前没有可排序的计算结果。各结构卡片显示缺项或尺寸冲突。';
  return {summary, items, priority, rankings, metricName};
}
