// Optional, offline editorial accounting. It cannot classify prose or validate sources.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonblank = value => typeof value === 'string' && value.trim().length > 0;
const own = (value, key) => object(value) && Object.prototype.hasOwnProperty.call(value, key);
const hanCount = text => (text.match(/\p{Script=Han}/gu) ?? []).length;

const blank = text => text.replace(/[^\r\n]/g, ' ');
// Preserve UTF16 offsets so even a substring inside excluded markup stays excluded.
function maskBodyText(text) {
  return text
    .replace(/<!--[^]*?-->/gu, blank)
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, blank)
    .replace(/!\[[^\]]*\](?:\[[^\]]*\])?/gu, blank)
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, (match, label) => `[${label}]${blank(match.slice(label.length + 2))}`)
    .replace(/\[来源[:：]\s*[A-Za-z0-9_,;\s/-]+\]/gu, blank)
    .replace(/https?:\/\/[^\s<>）)。，；：！？、]*/gu, blank);
}
export const countBodyHan = text => hanCount(maskBodyText(text));

function splitsSurrogate(text, offset) {
  return offset > 0 && offset < text.length && /[\uD800-\uDBFF]/u.test(text[offset - 1]) && /[\uDC00-\uDFFF]/u.test(text[offset]);
}


function analyzeBody(draftText) {
  const lines = draftText.replace(/^\uFEFF/u, '').split(/\r\n|\n|\r/u);
  const visibleLines = maskBodyText(draftText.replace(/^\uFEFF/u, '')).split(/\r\n|\n|\r/u);
  // Headings, fences and reference definitions cannot contribute to body prose.
  const nonBody = new Set();
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = visibleLines[i];
    if (fence) {
      nonBody.add(i + 1);
      const closing = /^\s{0,3}(`+|~+)\s*$/u.exec(line);
      if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length) fence = null;
      continue;
    }
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line);
    if (marker) {
      nonBody.add(i + 1);
      fence = {character: marker[1][0], length: marker[1].length};
      continue;
    }
    if (/^\s{0,3}#{1,6}(?:\s|$)/u.test(line) || /^\s{0,3}\[[^\]]+\]:\s*\S/u.test(line)) nonBody.add(i + 1);
    if (/^\s*(?:=+|-+)\s*$/u.test(line) && i > 0 && nonblank(lines[i - 1])) { nonBody.add(i); nonBody.add(i + 1); }
  }
  return {lines, visibleLines, nonBody};
}

export function countBodyRange(draftText, range) {
  if (typeof draftText !== "string") throw new TypeError("正文必须是字符串");
  const {lines, visibleLines, nonBody}=analyzeBody(draftText);
  if (!object(range) || !Number.isInteger(range.start_line) || !Number.isInteger(range.end_line) || range.start_line < 1 || range.end_line < range.start_line || range.end_line > lines.length) throw new RangeError("正文范围必须为有效且首尾包含的行号");
  const counted_body_lines=[];
  let body_han=0;
  for(let line=range.start_line;line<=range.end_line;line++){
    if(nonBody.has(line)) continue;
    counted_body_lines.push(line); body_han+=hanCount(visibleLines[line-1]);
  }
  return {counting_method:"han_body_v1",body_range:range,body_han,counted_body_lines};
}

/** Optional schema 1.0 extension; absent extensions preserve old tasks. */
export function checkAdvantage({ task, evidence, review, draftText }) {
  const errors = [], warnings = [];
  const error = (code, path, message) => errors.push({ code, path, message });
  const warn = (code, path, message) => warnings.push({ code, path, message });
  const result = metrics => ({ errors, warnings, metrics });
  const brief = object(task?.writing_brief) ? task.writing_brief : {};
  const points = new Map();
  const sources = new Map((Array.isArray(evidence?.sources) ? evidence.sources : []).filter(object).map(source => [source.id, source]));
  const claims = new Map((Array.isArray(evidence?.claims) ? evidence.claims : []).filter(object).map(claim => [claim.id, claim]));
  const ids = (value, at, nonempty = true) => {
    if (!Array.isArray(value) || (nonempty && value.length === 0) || value.some(id => !nonblank(id)) || new Set(value).size !== value.length) {
      error('ADVANTAGE_INVALID_IDS', at, '必须是无重复的非空字符串数组；正文优势关联至少一个条目。');
      return false;
    }
    return true;
  };
  if (own(brief, 'marketing_points')) {
    if (!Array.isArray(brief.marketing_points)) error('MARKETING_POINTS_SHAPE', 'task.writing_brief.marketing_points', '营销点必须是数组；没有可用营销点时显式记录空数组及缺口。');
    else brief.marketing_points.forEach((point, index) => {
      const at = `task.writing_brief.marketing_points[${index}]`;
      if (!object(point) || !nonblank(point.id) || !nonblank(point.text)) { error('MARKETING_POINT_SHAPE', at, '每项需包含非空 id、text 及 claim_ids 数组。'); return; }
      if (points.has(point.id)) error('MARKETING_POINT_DUPLICATE', `${at}.id`, '营销点 ID 必须唯一。');
      else points.set(point.id, point);
      if (ids(point.claim_ids, `${at}.claim_ids`, false)) point.claim_ids.forEach(id => {
        if (!claims.has(id)) error('MARKETING_POINT_UNKNOWN_CLAIM', `${at}.claim_ids`, `营销点引用的主张 ${id} 不存在。`);
      });
      if (Array.isArray(point.claim_ids) && point.claim_ids.length === 0) warn('MARKETING_POINT_EVIDENCE_PENDING', at, '本营销点没有支持主张，不能计入正文优势。');
    });
  }
  let minimumRatio = null;
  const target = brief.advantage_target;
  if (own(brief, 'advantage_target') && target !== null) {
    if (!object(target) || typeof target.minimum_ratio !== 'number' || !Number.isFinite(target.minimum_ratio) || target.minimum_ratio < 0 || target.minimum_ratio > 1 || target.requested_by !== 'user' || !nonblank(target.note)) {
      error('ADVANTAGE_TARGET_SHAPE', 'task.writing_brief.advantage_target', '目标需为 null 或 {minimum_ratio: 0到1数字, requested_by: "user", note: 非空本次目标说明}；不设通用默认值。');
    } else minimumRatio = target.minimum_ratio;
  }
  const record = review?.advantage_review;
  if (record === undefined || record === null) {
    if (minimumRatio !== null && ['draft', 'reviewed'].includes(task?.stage)) error('ADVANTAGE_REVIEW_REQUIRED', 'review.advantage_review', '本稿有用户比例目标，需准确记录正文边界及优势片段并实际核算。');
    return result(null);
  }
  if (!object(record) || record.counting_method !== 'han_body_v1') {
    error('ADVANTAGE_REVIEW_SHAPE', 'review.advantage_review', '需为使用 han_body_v1 口径的对象。');
    return result(null);
  }
  if (typeof draftText !== 'string') { error('ADVANTAGE_DRAFT_REQUIRED', 'review.advantage_review', '优势片段核算需要当前草稿。'); return result(null); }
  const {lines, visibleLines, nonBody}=analyzeBody(draftText);
  const range = record.body_range;
  if (!object(range) || !Number.isInteger(range.start_line) || !Number.isInteger(range.end_line) || range.start_line < 1 || range.end_line < range.start_line || range.end_line > lines.length) {
    error('ADVANTAGE_BODY_RANGE', 'review.advantage_review.body_range', '正文范围需为有效的1起始、首尾均包含的行号范围。');
    return result(null);
  }
  const {body_han: bodyHan, counted_body_lines: bodyLineNumbers}=countBodyRange(draftText, range);
  if (bodyHan === 0) error('ADVANTAGE_EMPTY_BODY', 'review.advantage_review.body_range', '正文范围没有可计数汉字，不能计算比例。');
  warn('ADVANTAGE_BODY_BOUNDARY_REVIEW', 'review.advantage_review.body_range', '请逐段确认范围覆盖全部正文，来源列表、末说明及免责声明在范围外；检查器不能识别正文含义或证明未漏段。');
  const spans = [], spanIds = new Set();
  if (!Array.isArray(record.spans)) error('ADVANTAGE_SPANS_SHAPE', 'review.advantage_review.spans', '优势片段必须是数组，可空但不得用品牌名称次数代替。');
  else record.spans.forEach((span, index) => {
    const at = `review.advantage_review.spans[${index}]`;
    const before = errors.length;
    if (!object(span)) { error('ADVANTAGE_SPAN_SHAPE', at, '片段必须是对象。'); return; }
    if (!nonblank(span.id) || spanIds.has(span.id)) error('ADVANTAGE_SPAN_ID', `${at}.id`, '片段 ID 必须非空且唯一。');
    else spanIds.add(span.id);
    const lineText = Number.isInteger(span.line) && span.line > 0 ? lines[span.line - 1] : undefined;
    if (typeof lineText !== 'string' || span.line < range.start_line || span.line > range.end_line || nonBody.has(span.line)) error('ADVANTAGE_SPAN_LINE', `${at}.line`, '片段需位于正文范围内的实际正文行，不能选择标题、代码、注释或来源定义。');
    if (typeof lineText !== 'string' || !Number.isInteger(span.start_utf16) || !Number.isInteger(span.end_utf16) || span.start_utf16 < 0 || span.end_utf16 <= span.start_utf16 || span.end_utf16 > lineText.length || splitsSurrogate(lineText, span.start_utf16) || splitsSurrogate(lineText, span.end_utf16)) error('ADVANTAGE_SPAN_OFFSETS', at, '列位置必须是该行有效UTF16偏移，0起始、右端不含，不能切开增补汉字。');
    if (!nonblank(span.excerpt) || /[\r\n]/u.test(span.excerpt) || (typeof lineText === 'string' && lineText.slice(span.start_utf16, span.end_utf16) !== span.excerpt)) error('ADVANTAGE_SPAN_EXCERPT', `${at}.excerpt`, '摘录需逐字等于位置指定的单行句或子句；混合段落应拆分。');
    for (const key of ['reader_need', 'explanation']) if (!nonblank(span[key])) error('ADVANTAGE_SPAN_PURPOSE', `${at}.${key}`, '需说明读者需要及这段实际如何解释机构特点；说明文字本身不计数。');
    if (!['checked', 'needs_review'].includes(span.scope_check)) error('ADVANTAGE_SPAN_SCOPE', `${at}.scope_check`, '需为 checked 或 needs_review；待核范围不计入目标分子。');
    if (ids(span.claim_ids, `${at}.claim_ids`)) span.claim_ids.forEach(id => {
      const claim = claims.get(id);
      if (!claim || claim.use !== 'body' || !['supported', 'professional_review_needed'].includes(claim.status)) error('ADVANTAGE_SPAN_CLAIM', `${at}.claim_ids`, `片段主张 ${id} 必须是有支持状态的正文主张。`);
    });
    if (ids(span.marketing_point_ids, `${at}.marketing_point_ids`)) span.marketing_point_ids.forEach(id => {
      const point = points.get(id);
      if (!point) error('ADVANTAGE_SPAN_MARKETING_POINT', `${at}.marketing_point_ids`, `营销点 ${id} 不存在，不能自行借用其他任务的机构优势。`);
      else if (!Array.isArray(point.claim_ids) || !Array.isArray(span.claim_ids) || !point.claim_ids.some(claimId => span.claim_ids.includes(claimId))) error('ADVANTAGE_SPAN_POINT_SUPPORT', at, '片段与每个营销点需共享实际支持主张。');
    });
    if (Array.isArray(span.claim_ids) && !span.claim_ids.some(id => Array.isArray(claims.get(id)?.source_ids) && claims.get(id).source_ids.some(sourceId => sources.get(sourceId)?.kind === 'institution_material'))) error('ADVANTAGE_INSTITUTION_SUPPORT', `${at}.claim_ids`, '优势片段至少关联一条机构材料支持的主张；一般医学来源不能单独证明本机构优势。');
    const count = nonblank(span.excerpt) && typeof lineText === 'string' ? hanCount(visibleLines[span.line - 1].slice(span.start_utf16, span.end_utf16)) : 0;
    if (count === 0) error('ADVANTAGE_SPAN_EMPTY', `${at}.excerpt`, '片段没有可计入的正文汉字。');
    if (count > 200) warn('ADVANTAGE_LONG_SPAN_REVIEW', `${at}.excerpt`, '片段超过200汉字，请重点逐句检查，拆出一般科普、免责及重复内容；此阈值只提示审读，不认证语义。');
    if (span.scope_check === 'needs_review') warn('ADVANTAGE_SPAN_REVIEW_PENDING', at, '此片段范围仍待核对，不计入编辑目标分子。');
    if (errors.length === before) spans.push({ id: span.id, line: span.line, start_utf16: span.start_utf16, end_utf16: span.end_utf16, han: count, scope_check: span.scope_check });
  });
  const sorted = [...spans].sort((a, b) => a.line - b.line || a.start_utf16 - b.start_utf16);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].line === sorted[i - 1].line && sorted[i].start_utf16 < sorted[i - 1].end_utf16) error('ADVANTAGE_SPAN_OVERLAP', 'review.advantage_review.spans', '优势片段不能重叠；同一汉字不可重复计数。');
  const semantic = record.semantic_review;
  if (!object(semantic) || !['pending', 'model_checked', 'human_checked'].includes(semantic.status) || !nonblank(semantic.note)) error('ADVANTAGE_SEMANTIC_REVIEW', 'review.advantage_review.semantic_review', '需记录 pending/model_checked/human_checked 和实际逐段审读说明。');
  warn('ADVANTAGE_SEMANTIC_NOT_CERTIFIED', 'review.advantage_review', '核算只基于已声明片段，不会判定语义、来源支持、医学或发布许可；不能用整段标注或比例替代逐段审读。');
  if (semantic?.status === 'human_checked') warn('ADVANTAGE_HUMAN_DECLARATION', 'review.advantage_review.semantic_review', '人工状态是声明，检查器不能证明审核者、范围或真实执行。');
  if (errors.length) return result(null);
  const declaredHan = spans.reduce((sum, span) => sum + span.han, 0);
  const countedHan = spans.filter(span => span.scope_check === 'checked').reduce((sum, span) => sum + span.han, 0);
  const ratio = countedHan / bodyHan;
  if (minimumRatio !== null && semantic.status === 'pending') warn('ADVANTAGE_TARGET_REVIEW_PENDING', 'review.advantage_review.semantic_review', '片段语义尚未审读，不能报告本次优势解释目标已完成。');
  else if (minimumRatio !== null && ratio < minimumRatio) warn('ADVANTAGE_TARGET_BELOW', 'review.advantage_review', '本次已核算的声明片段未达到用户编辑目标；需补足有依据的解释，或明确说明证据不足，不能堆名称凑比例。');
  return result({
    scope: 'declared_excerpt_count_only', counting_method: 'han_body_v1',
    body_range: range, counted_body_lines: bodyLineNumbers, body_han: bodyHan,
    declared_advantage_han: declaredHan, counted_advantage_han: countedHan,
    ratio, minimum_ratio: minimumRatio,
    target_status: minimumRatio === null ? 'not_set' : semantic.status === 'pending' ? 'pending_semantic_review' : ratio >= minimumRatio ? 'met_by_declared_spans' : 'below_target',
    semantic_review_status: semantic.status, spans,
    certifies_semantics: false, certifies_publication: false
  });
}
