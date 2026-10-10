#!/usr/bin/env node
// Offline artifact consistency checks only. Never reads or fetches source locations.
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAdvantage, countBodyRange } from './advantage-metrics.mjs';

const ARTIFACTS = ['task.json', 'evidence.json', 'outline.md', 'draft.md', 'review.json'];
const STAGES = ['brief', 'outline', 'draft', 'reviewed'];
const CAVEAT = '仅检查本地产物的结构、状态声明、引用对应和版本一致性；不证明事实支持、医学正确、真实人工审核、法律合规、AI 采信效果或发布许可。';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonblank = value => typeof value === 'string' && value.trim().length > 0;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function validISODate(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  date.setUTCHours(0, 0, 0, 0);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return false;
  if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59)) return false;
  if (zone && zone !== 'Z') {
    const [zoneHour, zoneMinute] = zone.slice(1).split(':').map(Number);
    if (zoneHour > 23 || zoneMinute > 59) return false;
  }
  return true;
}

function safeLocation(value) {
  if (!nonblank(value) || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value.trim());
  // Windows drive paths, including drive-relative paths, are local references.
  if (scheme && scheme[1].length === 1) return true;
  if (!scheme) return true;
  if (!/^https?$/i.test(scheme[1])) return false;
  if (!/^https?:\/\//i.test(value) || /\s/u.test(value) || value.includes('\\')) return false;
  try {
    const url = new URL(value);
    const authority = value.replace(/^https?:\/\//i, '').split(/[/?#]/, 1)[0];
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !authority.includes('@') && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Check the five artifacts in one task directory. Extra schema fields are ignored.
 * Results are deterministic for unchanged bytes; no network, model, clock or source reads.
 */
export async function checkTask(folder) {
  const errors = [];
  const warnings = [];
  let advantageMetrics = null;
  const error = (code, at, message) => errors.push({ code, path: at, message });
  const warn = (code, at, message) => warnings.push({ code, path: at, message });
  const result = () => ({
    ok: errors.length === 0,
    scope: 'artifact_structure_only',
    certifies_content: false,
    publication_ready: false,
    caveat: CAVEAT,
    errors,
    warnings,
    advantage_metrics: advantageMetrics
  });

  if (!nonblank(folder)) {
    error('INVALID_DIRECTORY', 'folder', '任务目录必须是非空路径。');
    return result();
  }
  const root = path.resolve(folder);
  try {
    const stat = await lstat(root);
    if (stat.isSymbolicLink()) {
      error('SYMLINK_ARTIFACT', 'folder', '任务目录不能是符号链接或目录联接。');
      return result();
    }
    if (!stat.isDirectory()) {
      error('INVALID_DIRECTORY', 'folder', '任务路径必须是目录。');
      return result();
    }
  } catch {
    error('INVALID_DIRECTORY', 'folder', '无法读取任务目录。');
    return result();
  }

  const files = new Map();
  const existingFiles = new Set();
  const failedFiles = new Set();
  for (const name of ARTIFACTS) {
    const filename = path.join(root, name);
    let handle;
    try {
      const stat = await lstat(filename);
      existingFiles.add(name);
      if (stat.isSymbolicLink()) {
        error('SYMLINK_ARTIFACT', name, '产物不能是符号链接或目录联接。');
        failedFiles.add(name);
        continue;
      }
      if (!stat.isFile()) {
        error('ARTIFACT_NOT_FILE', name, '产物必须是普通文件。');
        failedFiles.add(name);
        continue;
      }
      // Names are fixed literals, never schema values; no source/original path is opened.
      handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      if (!(await handle.stat()).isFile()) {
        error('ARTIFACT_NOT_FILE', name, '产物必须是普通文件。');
        failedFiles.add(name);
        continue;
      }
      const bytes = await handle.readFile();
      try {
        files.set(name, { bytes, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) });
      } catch {
        error('INVALID_UTF8', name, '产物必须使用有效 UTF-8 编码。');
        failedFiles.add(name);
      }
    } catch (cause) {
      if (cause.code !== 'ENOENT') {
        error('FILE_READ_FAILED', name, '无法读取产物文件。');
        failedFiles.add(name);
      }
    } finally {
      if (handle) await handle.close();
    }
  }

  function requiredFile(name) {
    if (!files.has(name) && !failedFiles.has(name)) error('MISSING_FILE', name, '缺少此阶段要求的产物文件。');
    return files.get(name);
  }
  function json(name, required) {
    const file = required ? requiredFile(name) : files.get(name);
    if (!file) return undefined;
    try { return JSON.parse(file.text.replace(/^\uFEFF/u, '')); }
    catch { error('INVALID_JSON', name, '文件不是有效 JSON。'); return undefined; }
  }
  function object(value, at) {
    if (!isObject(value)) { error('INVALID_SHAPE', at, '必须是对象。'); return false; }
    return true;
  }
  function fields(value, names, at) {
    for (const name of names) if (!own(value, name)) error('MISSING_FIELD', `${at}.${name}`, '缺少必填字段。');
  }
  function string(value, at, requiredNonblank = false) {
    if (typeof value !== 'string' || (requiredNonblank && !nonblank(value))) {
      error('INVALID_VALUE', at, requiredNonblank ? '必须是非空字符串。' : '必须是字符串。');
      return false;
    }
    return true;
  }
  function nullableString(value, at, requiredNonblank = false) { return value === null || string(value, at, requiredNonblank); }
  function enumeration(value, values, at) {
    if (!values.includes(value)) { error('INVALID_VALUE', at, `必须是以下值之一：${values.join(' / ')}。`); return false; }
    return true;
  }
  function array(value, at) {
    if (!Array.isArray(value)) { error('INVALID_SHAPE', at, '必须是数组。'); return false; }
    return true;
  }
  function stringArray(value, at, requiredNonempty = false) {
    if (!array(value, at)) return false;
    if (requiredNonempty && value.length === 0) error('INVALID_VALUE', at, '至少需要一个条目。');
    value.forEach((item, index) => string(item, `${at}[${index}]`, requiredNonempty));
    return true;
  }
  function uniqueId(value, at, map) {
    if (!string(value, at, true)) return false;
    if (map.has(value)) { error('DUPLICATE_ID', at, 'ID 在同一集合内必须唯一。'); return false; }
    return true;
  }

  const task = json('task.json', true);
  const evidence = json('evidence.json', true);
  const protectedItems = new Map();
  let stageIndex = -1;
  if (task !== undefined && object(task, 'task')) {
    fields(task, ['schema_version', 'task_id', 'mode', 'stage', 'question', 'institution', 'target_ai', 'content_kind', 'channel', 'material_ids', 'original_path', 'protected_items', 'outline_authorization'], 'task');
    enumeration(task.schema_version, ['1.0'], 'task.schema_version');
    string(task.task_id, 'task.task_id', true);
    enumeration(task.mode, ['plan', 'write', 'revise'], 'task.mode');
    if (enumeration(task.stage, STAGES, 'task.stage')) stageIndex = STAGES.indexOf(task.stage);
    if (task.mode === 'plan' && stageIndex >= 2) error('PLAN_STAGE_CONFLICT', 'task.stage', 'plan 模式仅允许 brief 或 outline 阶段；全文任务需真实授权并更新 mode。');
    string(task.question, 'task.question', true);
    if (object(task.institution, 'task.institution')) {
      fields(task.institution, ['name', 'aliases'], 'task.institution');
      string(task.institution.name, 'task.institution.name', true);
      stringArray(task.institution.aliases, 'task.institution.aliases');
    }
    stringArray(task.target_ai, 'task.target_ai');
    enumeration(task.content_kind, ['medical_explanation', 'institution_information', 'service_selection', 'mixed'], 'task.content_kind');
    nullableString(task.channel, 'task.channel', true);
    stringArray(task.material_ids, 'task.material_ids');
    nullableString(task.original_path, 'task.original_path');
    if (task.mode === 'revise' && !nonblank(task.original_path)) error('ORIGINAL_REQUIRED', 'task.original_path', '改稿任务必须填写非空原文路径；此检查器不会读取该路径。');
    enumeration(task.outline_authorization, ['pending', 'approved', 'full_draft_authorized'], 'task.outline_authorization');
    if (stageIndex >= 2 && task.outline_authorization === 'pending') error('DRAFT_AUTHORIZATION_REQUIRED', 'task.outline_authorization', '草稿阶段必须已有提纲批准或完整草稿授权声明。');
    if (array(task.protected_items, 'task.protected_items')) task.protected_items.forEach((item, index) => {
      const at = `task.protected_items[${index}]`;
      if (!object(item, at)) return;
      fields(item, ['id', 'text', 'action'], at);
      if (uniqueId(item.id, `${at}.id`, protectedItems)) protectedItems.set(item.id, item);
      string(item.text, `${at}.text`, true);
      enumeration(item.action, ['preserve', 'correct_with_reason'], `${at}.action`);
    });
  }

  const sources = new Map();
  const claims = new Map();
  if (evidence !== undefined && object(evidence, 'evidence')) {
    fields(evidence, ['schema_version', 'sources', 'claims'], 'evidence');
    enumeration(evidence.schema_version, ['1.0'], 'evidence.schema_version');
    if (array(evidence.sources, 'evidence.sources')) evidence.sources.forEach((source, index) => {
      const at = `evidence.sources[${index}]`;
      if (!object(source, at)) return;
      fields(source, ['id', 'kind', 'location', 'locator', 'checked_at', 'read_status', 'origin', 'limitations'], at);
      if (uniqueId(source.id, `${at}.id`, sources)) sources.set(source.id, source);
      enumeration(source.kind, ['institution_material', 'medical_reference', 'monitoring_clue', 'original_article'], `${at}.kind`);
      if (!safeLocation(source.location)) error('UNSAFE_SOURCE_LOCATION', `${at}.location`, '必须是非空本地路径或无凭据、控制字符和空白的 HTTP(S) 地址；其他 URL 协议不受支持。');
      string(source.locator, `${at}.locator`);
      if (source.checked_at !== null && !validISODate(source.checked_at)) error('INVALID_DATE', `${at}.checked_at`, '必须为真实 ISO 日期、带时区的 ISO 日期时间或 null。');
      enumeration(source.read_status, ['not_read', 'read'], `${at}.read_status`);
      if ((source.read_status === 'read' && source.checked_at === null) || (source.read_status === 'not_read' && source.checked_at !== null)) error('SOURCE_READ_DATE', `${at}.checked_at`, '已读取来源必须有检查日期；未读取来源的检查日期必须是 null。');
      enumeration(source.origin, ['user_provided', 'public_source', 'monitoring'], `${at}.origin`);
      string(source.limitations, `${at}.limitations`);
    });
    if (array(evidence.claims, 'evidence.claims')) evidence.claims.forEach((claim, index) => {
      const at = `evidence.claims[${index}]`;
      if (!object(claim, at)) return;
      fields(claim, ['id', 'text', 'source_ids', 'status', 'scope', 'limitations', 'use'], at);
      if (uniqueId(claim.id, `${at}.id`, claims)) claims.set(claim.id, claim);
      string(claim.text, `${at}.text`, true);
      if (stringArray(claim.source_ids, `${at}.source_ids`, true)) claim.source_ids.forEach((id, sourceIndex) => {
        const source = sources.get(id);
        const sourceAt = `${at}.source_ids[${sourceIndex}]`;
        if (!source) { error('UNKNOWN_SOURCE', sourceAt, '主张引用的来源 ID 不存在。'); return; }
        if ((claim.status === 'supported' || (claim.use === 'body' && claim.status === 'professional_review_needed')) && source.read_status !== 'read') error('BODY_SOURCE_NOT_READ', sourceAt, 'supported 主张和正文待专业复核主张的来源必须声明为已读取。');
        if (claim.use === 'body' && source.kind === 'monitoring_clue') error('MONITORING_AS_FACT', sourceAt, '监测线索不能作为正文事实的支持来源。');
        if (claim.use === 'body' && source.kind === 'original_article') error('ORIGINAL_AS_FACT', sourceAt, '旧稿本身不能作为正文事实的支持来源；需引用其可读取的原始依据。');
      });
      enumeration(claim.status, ['unverified', 'supported', 'professional_review_needed', 'conflicting', 'outdated', 'unusable'], `${at}.status`);
      string(claim.scope, `${at}.scope`);
      string(claim.limitations, `${at}.limitations`);
      enumeration(claim.use, ['body', 'internal_only'], `${at}.use`);
      if (claim.use === 'body' && !['supported', 'professional_review_needed'].includes(claim.status)) error('UNSUPPORTED_BODY_CLAIM', `${at}.status`, '正文主张只能使用 supported 或 professional_review_needed 状态。');
      if (claim.use === 'body' && claim.status === 'professional_review_needed') warn('PROFESSIONAL_REVIEW_NEEDED', at, '此正文主张仍需相应专业人员审核。');
    });
  }

  if (stageIndex >= 1) {
    const outline = requiredFile('outline.md');
    if (outline && !nonblank(outline.text)) error('EMPTY_OUTLINE', 'outline.md', '提纲不得为空。');
  }
  if (stageIndex >= 0 && stageIndex < 2 && existingFiles.has('draft.md')) error('DRAFT_STAGE_CONFLICT', 'draft.md', 'brief 或 outline 阶段不应存在全文草稿；请核对真实任务授权与阶段。');
  const draft = stageIndex >= 2 ? requiredFile('draft.md') : files.get('draft.md');
  if (draft && !nonblank(draft.text)) error('EMPTY_DRAFT', 'draft.md', '草稿不得为空。');
  const review = json('review.json', stageIndex >= 2);
  if (review !== undefined && object(review, 'review')) {
    fields(review, ['schema_version', 'task_id', 'draft_sha256', 'mapping', 'brand_mentions', 'checks', 'blockers', 'notes'], 'review');
    enumeration(review.schema_version, ['1.0'], 'review.schema_version');
    if (string(review.task_id, 'review.task_id', true) && isObject(task) && review.task_id !== task.task_id) error('TASK_ID_MISMATCH', 'review.task_id', '审核记录必须对应同一 task_id。');
    if (typeof review.draft_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(review.draft_sha256)) error('INVALID_HASH', 'review.draft_sha256', '必须是 64 位小写 SHA-256 十六进制摘要。');
    if (!draft) error('REVIEW_WITHOUT_DRAFT', 'review.draft_sha256', '审核记录必须有对应草稿文件。');
    else if (review.draft_sha256 !== createHash('sha256').update(draft.bytes).digest('hex')) error('DRAFT_HASH_MISMATCH', 'review.draft_sha256', '草稿原始字节已改变，必须更新针对当前版本的审核记录。');
    const mappedClaims = new Set();
    if (array(review.mapping, 'review.mapping')) review.mapping.forEach((entry, index) => {
      const at = `review.mapping[${index}]`;
      if (!object(entry, at)) return;
      fields(entry, ['claim_id', 'excerpt', 'scope_check'], at);
      string(entry.claim_id, `${at}.claim_id`, true);
      const claim = claims.get(entry.claim_id);
      if (!claim) error('UNKNOWN_CLAIM', `${at}.claim_id`, '映射的主张 ID 不存在。');
      else if (claim.use === 'internal_only') error('INTERNAL_CLAIM_MAPPED', `${at}.claim_id`, '内部待补主张不能映射成正文已确认事实。');
      else mappedClaims.add(entry.claim_id);
      if (string(entry.excerpt, `${at}.excerpt`, true) && draft && !draft.text.includes(entry.excerpt)) error('EXCERPT_NOT_FOUND', `${at}.excerpt`, '映射摘录必须逐字存在于当前草稿。');
      enumeration(entry.scope_check, ['checked', 'needs_review'], `${at}.scope_check`);
      if (entry.scope_check === 'needs_review') warn('SCOPE_REVIEW_NEEDED', `${at}.scope_check`, '此摘录的适用范围仍待核对。');
    });
    for (const [id, claim] of claims) if (claim.use === 'body' && !mappedClaims.has(id)) error('BODY_CLAIM_UNMAPPED', 'review.mapping', `正文主张 ${id} 缺少摘录映射。`);
    if (array(review.brand_mentions, 'review.brand_mentions')) review.brand_mentions.forEach((entry, index) => {
      const at = `review.brand_mentions[${index}]`;
      if (!object(entry, at)) return;
      fields(entry, ['excerpt', 'purpose', 'claim_ids'], at);
      if (string(entry.excerpt, `${at}.excerpt`, true) && draft && !draft.text.includes(entry.excerpt)) error('EXCERPT_NOT_FOUND', `${at}.excerpt`, '机构出现摘录必须逐字存在于当前草稿。');
      string(entry.purpose, `${at}.purpose`, true);
      if (stringArray(entry.claim_ids, `${at}.claim_ids`)) {
        if (entry.claim_ids.length === 0) warn('BRAND_EVIDENCE_REVIEW_NEEDED', `${at}.claim_ids`, '此机构摘录未关联主张；相关性和证据需人工核对。');
        entry.claim_ids.forEach((id, claimIndex) => {
          if (!claims.has(id)) error('UNKNOWN_CLAIM', `${at}.claim_ids[${claimIndex}]`, '机构摘录引用的主张 ID 不存在。');
          else if (claims.get(id).use === 'internal_only') error('INTERNAL_BRAND_CLAIM', `${at}.claim_ids[${claimIndex}]`, '机构正文摘录只能关联 body 主张，不能关联内部待补主张。');
        });
      }
    });
    if (object(review.checks, 'review.checks')) {
      fields(review.checks, ['format', 'source_support', 'medical', 'publication'], 'review.checks');
      enumeration(review.checks.format, ['pending', 'checked'], 'review.checks.format');
      enumeration(review.checks.source_support, ['pending', 'model_checked', 'human_checked'], 'review.checks.source_support');
      enumeration(review.checks.medical, ['not_applicable', 'pending', 'human_checked'], 'review.checks.medical');
      enumeration(review.checks.publication, ['pending_channel', 'pending_review', 'human_checked'], 'review.checks.publication');
      if (isObject(task) && task.channel === null && review.checks.publication !== 'pending_channel') error('CHANNEL_STATE_CONFLICT', 'review.checks.publication', '渠道未确定时，发布检查状态只能为 pending_channel。');
      if ([...claims.values()].some(claim => claim.use === 'body' && claim.status === 'professional_review_needed') && ['not_applicable', 'human_checked'].includes(review.checks.medical)) error('MEDICAL_STATE_CONFLICT', 'review.checks.medical', '正文仍有待专业复核主张时，医学检查状态必须保持 pending。');
      if (review.checks.format === 'pending') warn('FORMAT_REVIEW_PENDING', 'review.checks.format', '格式审核状态仍为待审。');
      if (review.checks.source_support === 'pending') warn('SOURCE_SUPPORT_PENDING', 'review.checks.source_support', '来源对主张的实际支持仍待检查。');
      if (review.checks.medical === 'pending') warn('MEDICAL_REVIEW_PENDING', 'review.checks.medical', '医学审核仍为待审。');
      if (review.checks.publication === 'pending_channel') warn('CHANNEL_REVIEW_PENDING', 'review.checks.publication', '发布渠道尚待确定和审核。');
      if (review.checks.publication === 'pending_review') warn('PUBLICATION_REVIEW_PENDING', 'review.checks.publication', '具体发布审核仍待完成。');
      for (const key of ['source_support', 'medical', 'publication']) if (review.checks[key] === 'human_checked') warn('HUMAN_REVIEW_DECLARED_UNVERIFIED', `review.checks.${key}`, '此字段仅为人工审核声明；当前结构没有可独立验证的审核者和版本记录，本检查器不能证明其真实性。');
    }
    stringArray(review.blockers, 'review.blockers');
    stringArray(review.notes, 'review.notes');
    if (Array.isArray(review.blockers)) review.blockers.forEach((blocker, index) => {
      if (nonblank(blocker)) warn('DECLARED_BLOCKER', `review.blockers[${index}]`, '记录中存在待解决项；格式检查不会解除它。');
    });
  }
  if (stageIndex >= 2 && draft) {
    for (const [id, item] of protectedItems) {
      if (item.action === 'preserve' && nonblank(item.text) && !draft.text.includes(item.text)) error('PROTECTED_TEXT_MISSING', 'draft.md', `需保留的文本 ${id} 未逐字存在于草稿。`);
      if (item.action === 'correct_with_reason') {
        const hasReason = isObject(review) && Array.isArray(review.notes) && review.notes.some(note => typeof note === 'string' && note.includes(id) && nonblank(note.replace(id, '')));
        if (!hasReason) error('PROTECTED_CORRECTION_REASON_MISSING', 'review.notes', `修正受保护项 ${id} 需要含该 ID 和非空理由的说明；检查器不判断理由是否充分。`);
      }
    }
    if (isObject(task) && task.channel === null) warn('CHANNEL_UNDETERMINED', 'task.channel', '渠道未确定；通用草稿不能据此获得发布许可。');
  }
  const advantage = checkAdvantage({ task, evidence, review, draftText: draft?.text });
  errors.push(...advantage.errors);
  warnings.push(...advantage.warnings);
  // Optional records remain compatible with old tasks; present records must be filled.
  if (stageIndex >= 2 && isObject(review)) {
    const editorial = review.editorial_review;
    if (editorial === undefined) warn('EDITORIAL_RECORD_MISSING', 'review.editorial_review', '旧任务可继续检查；新完整稿和实质改稿需补实际编辑观察。');
    else if (object(editorial, 'review.editorial_review')) {
      enumeration(editorial.status, ['pending', 'model_checked', 'human_checked'], 'review.editorial_review.status');
      for (const key of ['question_and_title', 'explanation_depth', 'institution_integration', 'style_and_repetition']) string(editorial[key], `review.editorial_review.${key}`, true);
      for (const key of ['requirements_not_met', 'revision_actions']) {
        if (array(editorial[key], `review.editorial_review.${key}`)) editorial[key].forEach((entry,index)=>string(entry,`review.editorial_review.${key}[${index}]`,true));
      }
      if (array(editorial.section_contributions, 'review.editorial_review.section_contributions')) editorial.section_contributions.forEach((entry,index)=>{
        const at=`review.editorial_review.section_contributions[${index}]`;
        if(typeof entry === 'string') string(entry,at,true);
        else if(object(entry,at)){string(entry.section,`${at}.section`,true);string(entry.new_information,`${at}.new_information`,true);}
      });
      if (Array.isArray(editorial.section_contributions) && editorial.section_contributions.length === 0) error('EDITORIAL_SECTIONS_EMPTY', 'review.editorial_review.section_contributions', '需说明实际章节或短文的贡献；未检查时写清待办，不能留下空模板。');
      const length = editorial.length_review;
      if (object(length, 'review.editorial_review.length_review')) {
        for (const key of ['counting', 'target', 'assessment']) string(length[key], `review.editorial_review.length_review.${key}`, true);
        if (length.actual_body_han !== null && (!Number.isInteger(length.actual_body_han) || length.actual_body_han < 0)) error('EDITORIAL_COUNT_INVALID', 'review.editorial_review.length_review.actual_body_han', '实际汉字数需为非负整数，未计数为null。');
        if (length.body_range != null && draft) {
          try {
            const metric = countBodyRange(draft.text, length.body_range);
            if (length.counting !== 'han_body_v1') error('EDITORIAL_COUNT_METHOD', 'review.editorial_review.length_review.counting', '给出正文行范围时使用共享han_body_v1口径。');
            if (length.actual_body_han !== null && length.actual_body_han !== metric.body_han) error('EDITORIAL_COUNT_MISMATCH', 'review.editorial_review.length_review.actual_body_han', '所填字数与当前正文范围的实际核算不一致。');
            if (advantage.metrics && (length.body_range.start_line !== advantage.metrics.body_range.start_line || length.body_range.end_line !== advantage.metrics.body_range.end_line)) error('BODY_RANGE_MISMATCH', 'review.editorial_review.length_review.body_range', '篇幅与优势比例必须使用同一完整正文范围。');
          } catch { error('EDITORIAL_BODY_RANGE', 'review.editorial_review.length_review.body_range', '正文范围必须是当前草稿有效行号。'); }
        } else if (length.actual_body_han !== null) warn('EDITORIAL_COUNT_NOT_VERIFIED', 'review.editorial_review.length_review', '旧记录未提供正文范围，实际字数尚未由共享计数器验证。');
        if (length.actual_body_han === null) warn('EDITORIAL_COUNT_PENDING', 'review.editorial_review.length_review', '实际计数未完成，不能声明篇幅已核算。');
      }
      if (editorial.status === 'pending') warn('EDITORIAL_REVIEW_PENDING', 'review.editorial_review', '编辑审读仍待完成。');
      if (editorial.status === 'human_checked') warn('EDITORIAL_HUMAN_DECLARED', 'review.editorial_review', '人工状态仅为声明，此工具不能验证审核者和实际执行。');
    }
    const medical = review.evidence_review;
    if (medical === undefined) warn('EVIDENCE_RECORD_MISSING', 'review.evidence_review', '旧任务可继续检查；新医学稿需补实际依据审读，非医学任务说明不适用。');
    else if (object(medical, 'review.evidence_review')) {
      enumeration(medical.status, ['pending', 'model_checked', 'human_checked', 'not_applicable'], 'review.evidence_review.status');
      if (array(medical.pivotal_claim_ids, 'review.evidence_review.pivotal_claim_ids')) medical.pivotal_claim_ids.forEach((id,index)=>string(id,`review.evidence_review.pivotal_claim_ids[${index}]`,true));
      if (Array.isArray(medical.pivotal_claim_ids)) for (const id of medical.pivotal_claim_ids) if (!claims.has(id) || claims.get(id).use !== 'body') error('EVIDENCE_REVIEW_CLAIM', 'review.evidence_review.pivotal_claim_ids', '关键主张ID必须指向当前正文主张。');
      const fieldsToRead = ['applicability_findings', 'numerical_and_comparison_findings', 'added_or_removed_claims', 'unresolved_items'];
      for (const key of fieldsToRead) if (array(medical[key], `review.evidence_review.${key}`)) medical[key].forEach((entry,index)=>string(entry,`review.evidence_review.${key}[${index}]`,true));
      if (!fieldsToRead.some(key => Array.isArray(medical[key]) && medical[key].some(nonblank))) error('EVIDENCE_REVIEW_EMPTY', 'review.evidence_review', '至少写明实际发现、待办或不适用理由，不能保留空审核模板。');
      if (medical.status === 'not_applicable' && (task?.content_kind === 'medical_explanation' || task?.content_kind === 'mixed' || [...claims.values()].some(c=>c.use==='body' && c.status==='professional_review_needed'))) error('EVIDENCE_REVIEW_CONFLICT', 'review.evidence_review.status', '医学或混合任务、待专业复核主张不能将依据审读标为不适用。');
      if (medical.status === 'pending') warn('EVIDENCE_REVIEW_PENDING', 'review.evidence_review', '依据审读仍待完成，模型检查不能解除医学人审。');
      if (medical.status === 'human_checked') warn('EVIDENCE_HUMAN_DECLARED', 'review.evidence_review', '人工状态仅为声明，此工具不能证明专业复核。');
    }
  }
  advantageMetrics = errors.length === 0 ? advantage.metrics : null;
  return result();
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const paths = args.filter(arg => arg !== '--json');
  if (args.includes('--help') || args.includes('-h')) {
    console.log('用法：node scripts/check-task.mjs <任务目录> [--json]\n此工具只检查本地产物，不读取来源或原文路径，不提供医学或发布认证。');
    return;
  }
  if (paths.length !== 1 || paths[0].startsWith('--')) {
    console.error('用法：node scripts/check-task.mjs <任务目录> [--json]');
    process.exitCode = 1;
    return;
  }
  const report = await checkTask(paths[0]);
  if (jsonOutput) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(report.ok ? '格式与引用对应检查未发现错误。' : '格式与引用对应检查发现错误。');
    console.log(report.caveat);
    for (const item of report.errors) console.log(`错误 [${item.code}] ${item.path}：${item.message}`);
    for (const item of report.warnings) console.log(`待复核 [${item.code}] ${item.path}：${item.message}`);
    if (report.advantage_metrics) {
      const metric = report.advantage_metrics;
      console.log(`编辑核算：正文 ${metric.body_han} 汉字，已声明并检查范围的优势片段 ${metric.counted_advantage_han} 汉字，占 ${(metric.ratio * 100).toFixed(2)}%；目标状态 ${metric.target_status}。`);
    }
    console.log(`错误 ${report.errors.length} 项，待复核 ${report.warnings.length} 项。`);
  }
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('产物检查未能完成；不能据此判断格式通过。');
    process.exitCode = 1;
  });
}
