# 交付约定：版本 1.0

本约定用于 Skill 文件交付，也为未来系统/API保留输入输出边界。当前是文件约定，不是系统状态机或自动审批服务。JSON字段使用英文，正文使用用户所需语言。核心文件保持schema1.0；0.4.0增加的内容计划/附属交付是独立辅助产物，不代表检查器新增了覆盖范围。

## 文件与阶段

| stage | 必需文件 | 含义 |
|---|---|---|
| brief | task.json、evidence.json | 已整理任务与目前可用/不可用主张，可有资料缺口 |
| outline | 上述文件、outline.md | 提纲已交付，可能尚待确认 |
| draft | 上述文件、draft.md、review.json | 已保存待审核正文及对应关系 |
| reviewed | 同draft | 完成一轮记录中的检查，不代表专业或发布审核全部完成 |

模式与阶段分开：mode为 `plan`、`write`、`revise`。plan不会仅因stage升级获得写全文授权；需用户实际提出继续或已授权全文后改mode。不能把用户授权做Skill当成授权撰写、发布一篇真实机构文章。

选题规划不一定包含单篇提纲：此时可用brief阶段的核心文件加辅助 `content-plan.json`，在任务说明中记录计划已交付；阶段只描述上述核心文件，不表示选题计划未完成。规划目标可作为task.question，选定题进入全文后另建单篇任务。

模板含空字段供填充，不是有效任务。校验器以已填任务为输入，不对模板报告内容验证通过。额外字段可以保存来源版本、时间范围、用户说明等，必需字段不能省略。

## task.json

- `schema_version`：固定 `1.0`。
- `task_id`：本次唯一非空标识，不含病人识别信息。
- `mode`、`stage`：使用上述枚举。
- `question`：本次要回答的主问题，非空。
- `institution`：`name`为指定机构规范名称；`aliases`为字符串数组，不能自行制造别名。
- `target_ai`：目标模型/平台字符串数组，可为空表示待指定，不自动创建真实监测。
- `content_kind`：`medical_explanation`、`institution_information`、`service_selection`、`mixed`之一。
- `channel`：未确定时为null；确定时为非空字符串。通用稿无需先选网站。
- `material_ids`：使用的原始输入材料标识数组，不在里面保存患者私密内容。
- `original_path`：改稿时保存原稿引用，其他模式可null。检查器不会读取这个路径；写作者只在用户授权范围内读它。
- `protected_items`：改稿需保留或纠正的条目数组。每项包含非空 `id`、`text`、`action`。action为 `preserve`（正文保留该原文）或 `correct_with_reason`（变更说明及review.notes记录理由，含该ID）。保护的是事实和边界，不是强制继续传播错误。
- `outline_authorization`：`pending`、`approved`、`full_draft_authorized`。只有用户实际确认或已授权全文才可记录后两者；提供了资料不等于确认提纲。draft/reviewed阶段不允许pending。

用户确认范围可另存 `authorization_note`。它是本次授权的说明，不是真实程序签名；不要复制旧任务的批准记录。

`writing_brief` 在schema层保持可选，保存本次编辑约定：`writing_goal`、`reader`、`reader_need`、`format`、`length_target`、`length_counting`、`reference_preferences`、`institution_role`。0.4.0可另存 `length_basis`（用户指定或自主工作目标及理由）、`requested_deliverables`（本次要交付的附属内容）。新写作任务按流程实际形成简报；旧任务无需为运行检查器补字段。篇幅按用户要求或编辑工作目标记录，参考偏好与事实依据分开，不套机构简介。

0.3.0新增的可选字段仍兼容schema1.0：`writing_brief.marketing_points`为使用者本次营销点数组，每项含id、text、claim_ids；`writing_brief.advantage_target`为null或使用者明确的比例目标对象。优势稿输入与比例定义见 [优势解释与比例核算](advantage-accounting.md)。这些字段不认证营销材料的真实性、标题或文风；旧任务没有扩展仍按原结构检查。

## evidence.json

顶层 `schema_version: "1.0"`，`sources`、`claims`两个数组。

source字段：

- `id`：来源唯一ID。
- `kind`：`institution_material`、`medical_reference`、`monitoring_clue`、`original_article`。
- `location`：原始文件引用或URL，非空。URL使用完整HTTP(S)，不带凭证、控制字符或首尾空格；本地路径是引用，不给其他工具隐含读取权。
- `locator`：相关页码、标题、段落或原文定位；资料暂未读时可为空。已读依据应有能找到对应内容的定位；现有检查器只检查字段类型，不核查定位是否具体或真实，需写作者逐项复核。
- `checked_at`：实际读取检查日期（YYYY-MM-DD）或带时区时间；未读取时null。不以今天日期补造读取记录。
- `read_status`：`not_read`、`read`。read表示读到了与主张有关的材料，并不证明其真实性；摘要访问限制写入limitations。
- `origin`：`user_provided`、`public_source`、`monitoring`。
- `limitations`：字符串，记录版本、权限、核验、访问或范围限制，可为空但不隐瞒已知限制。

claim字段：

- `id`、`text`：唯一主张ID及限定后的完整说法。
- `source_ids`：非空来源ID数组，指向存在的source。尚无出处时保留在review待补或任务缺口中，不造source以凑字段。
- `status`：`unverified`、`supported`、`professional_review_needed`、`conflicting`、`outdated`、`unusable`。含义见证据与机构表达。
- `scope`、`limitations`：适用范围和限制字符串。
- `use`：`body`或`internal_only`。只有supported或professional_review_needed的主张可用于待审正文，且全部支持来源必须读到。

监测线索和旧文不是事实依据：可作为internal_only主张出处，但不能混入body主张的source_ids。需要确认旧文事实时，寻找其真正依据另建source，不能更改来源kind来通过检查。

## outline.md

自然语言提纲，至少说明：问题/范围、文章性质、拟用结构、各节相关主张ID、机构信息位置及理由、缺口及复核需求。无需一字不差的固定标题模板。

## draft.md

仅保存文章正文及正文需要的来源/范围说明。内部任务单、审核状态和未生成图片方案另存。通用稿仍是草稿，不因内部文件分离就隐去必要披露。

不要让模型更新草稿哈希但保留过时的人审状态。修改后重建与真实正文一致的摘录，重新检查和复核。

## review.json

- `schema_version`：固定1.0；`task_id`与task一致。
- `draft_sha256`：draft.md原始字节SHA256，64位小写十六进制，不能按归一化正文计算。
- `mapping`：每条包括 `claim_id`、`excerpt`、`scope_check`。excerpt必须是draft.md中非空的准确原文；scope_check为 `checked`或`needs_review`。每条body主张至少有一个映射；internal_only主张不得映射成正文事实。必须逐条识别事实，不能故意不建主张使检查器看不到。
- `brand_mentions`：每条含正文准确 `excerpt`、信息 `purpose`、相关 `claim_ids`。机构身份提及没有独立事实主张时可空数组，但仍需说明作用并复核；所有事实性机构描述应关联依据。不是品牌密度评分。
- `checks`：记录各维度状态，见下表。
- `blockers`、`notes`：字符串数组。blockers列本稿尚未解决的重要问题；notes保存一般说明与改稿理由，不自动清空旧问题。

| checks字段 | 允许值 | 注意 |
|---|---|---|
| format | pending / checked | 结构检查，不是事实核验 |
| source_support | pending / model_checked / human_checked | 声明本次执行者，不能伪造人工检查 |
| medical | not_applicable / pending / human_checked | 若有医学说法不能仅靠content_kind把它判为不适用 |
| publication | pending_channel / pending_review / human_checked | channel为null时只能pending_channel；已选渠道不表示审核通过 |

已有真实审核可另存 `human_reviews` 记录审核者、日期、草稿哈希、审核范围和原始回执引用。检查器不能证实这些人的身份或真实执行情况，会把human_checked当声明而非证书。模型不能自行填写专家名字或“人工通过”。

对professional_review_needed主张，medical应保持pending；实际专业审核完成后仍须检查其结论是否支持说法，在新版本中更新主张和记录，不仅改一个状态词。

`editorial_review` 在schema层保持可选以兼容旧数据，但0.4.0工作流程要求新完整草稿及实质改稿保存具体编辑观察。模板提供：`status`、`question_and_title`、`explanation_depth`、`section_contributions`、`length_review`、`institution_integration`、`style_and_repetition`、`requirements_not_met`和`revision_actions`。`status`为pending/model_checked/human_checked；模型不能自填人工检查。`length_review`记录实际正文汉字数（`actual_body_han`）、计数口径、目标及判断；未执行计数时保持null并说明。其他字段写实际观察，不适用项说明原因，不以分数或勾选通过认证文章好坏。用户反馈不满意也要保留，不能用结构退出0覆盖反馈。

0.5.0起，draft/reviewed中存在这份记录时校验状态与必需观察：说明字段不能为空，`section_contributions`至少一项非空说明，或含非空`section`和`new_information`的对象；`requirements_not_met`和`revision_actions`为字符串数组。未完成时写明实际待办并保持pending，不复制空模板。旧任务缺少整份记录只提示补充，不能据此称新稿已完成审读。

新任务的`length_review.body_range`记录完整正文的首末行，与优势核算使用同一范围；`counting`使用`han_body_v1`，`actual_body_han`按共享工具实际计算，检查器核对数值和范围一致性。旧任务未提供范围时只提示字数未验证；尚未计数保留null及说明。医学条件、风险和限制属于正文，不因改称免责声明而排除。完整口径只维护在[优势核算参考](advantage-accounting.md)。

可选 `advantage_review` 记录当前正文边界、句/子句级优势摘录位置、本次营销点/主张ID、读者关联、范围检查及实际语义审读说明。字段和计数口径见 [优势解释与比例核算](advantage-accounting.md)。有明确比例目标的draft/reviewed任务必须提供该记录并实际核算；没有目标不强制旧稿补写。检查器报告的advantage_metrics只是对声明片段的计数，不能从met_by_declared_spans推导专业/发布已审核或用户满意。

0.4.1模板另有 `evidence_review`，schema层可选；新完整医学稿/实质改稿按医学与发布复核中的方法保存实际观察，简单任务按影响范围记录。`status`为pending/model_checked/human_checked/not_applicable；后两者分别需要真实人工记录或实际无临床判断。`pivotal_claim_ids`列与临床选择相关且存在于evidence的正文主张ID；`applicability_findings`、`numerical_and_comparison_findings`、`added_or_removed_claims`、`unresolved_items`为说明字符串数组，写实际发现和处理，无相应内容时可空数组。至少一处保存具体发现、待办或不适用理由；没有临床判断时可在unresolved_items说明不适用，并不表示存在未解决临床问题。删掉的无依据原句可以留在检查记录，不建立虚假的body主张；新增主张需按原约定建来源与正文映射。0.5.0起校验已提供记录的字段、主张ID和明显状态冲突；医学/混合任务或存在待专业复核主张不能标not_applicable。缺少整份记录的旧任务只提示，未完成记录保持pending。检查器不能证明实际读源、发现是否充分或真实人审，不改变 `checks.medical`。

## 辅助内容计划与附属交付

按任务需要采用，五个核心文件的检查器不读取或验证这两个文件。它们使用 `artifact_type`、`artifact_version: "1.0"`，不冒充核心schema校验结果。辅助模板中的空条目供填充；实际交付删除未用占位，不能把空模板当成已完成计划或资产。

**content-plan.json** 对应 [内容开发](content-development.md)。保存规划目标、读者、范围/数量、资料消化和候选题；`material_summary`可记录“事实/主张ID—支持范围—读者需要—可写问题—关键缺口”。`candidates`每项保存问题、体裁/范围、相关主张与营销点ID、机构作用、医学依据需求、标题角度、选择理由和下一步。`selected_topic_ids`引用实际候选ID；`sequence_or_calendar`只在用户需要时记录拟定顺序/日期，不造搜索或效果指标。单题规划可直接使用自然语言提纲，不强制重复保存JSON。

候选题 `status` 使用 `candidate`（等待取舍）、`selected`（本次计划选择）或 `deferred`（暂不采用，说明原因）。`selected_topic_ids`与selected条目保持一致；选中题目只是编辑决定，不表示已获全文授权、医学审核或发布许可。辅助计划的字段及对应关系仍需实际审读，不由核心检查器自动核验。

0.4.2可选 `existing_content_review` 默认为null，表示没有保存已读旧文的对照记录；若有旧内容，只记录实际授权和读取范围，不能用null证明没有旧稿。需要保存时使用scope说明范围，items逐项列source_id（对应evidence中的旧文来源）、reader_task、overlap、proposed_action、reason，均以实际内容判断；proposed_action说明拟继续使用/更新/另写/暂缓，不声明已修改或发布。只有目录时保留未读正文的限制。候选的可选 `content_angle` 为字符串，解释本稿有依据的新增信息、相关主张与读者作用，也可在自然语言提纲保存，不强制旧任务补字段。

**content-package.json** 对应 [内容附属交付](content-package.md)。保存最终标题、标题方案和摘要及各自状态，`draft_sha256`填写所对应正文的真实哈希，尚无正文时为null。`items`逐项记录FAQ、目录、表格、图示/图片和链接等的用途、位置、内容或方案、实际资产位置、图注/alt、来源主张、权利状态与复核说明；不适用字段用null或空数组，不补造值。

内容项状态为planned/generated/provided/pending_confirmation/not_requested/not_applicable；`generated`仅表示实际写出/生成，不代表医学、权利或发布审核通过。`rights_status`可用not_checked/pending_confirmation/confirmed/not_applicable，并说明真实依据；模型无法确认时不能填confirmed。`web_fields`仅在符合渠道条件时填实际metadata/structured_data，否则保留null/空对象并说明未生成或待补原因。它们不构成站点部署或发布回执。

## SHA256示例

有Node.js时，可按文件字节计算（将路径换成本次正文位置）：

```javascript
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const hash = createHash('sha256').update(readFileSync('draft.md')).digest('hex');
```

## 检查器范围

依赖宿主Node.js，无第三方包和网络。输入是本次任务文件夹；只读取固定交付文件，不抓取source.location，不读取original_path指向的文件，也不向其他应用发送资料。

输出 `errors`（结构不一致，退出1）和 `warnings`（人工/语义待办，通常退出0）。无错误并不等于无待办。准确摘录或ID关系只能确认引用存在，不能证明来源支持正文，也不能发现未登记的事实；仍需完整正文复核。

如宿主没有文件工具或Node.js，不声称已运行。交付正文和同等依据/待补说明，并明确结构检查未执行。文件产物可由用户保存；不因此安装依赖或偷偷调用外部服务。
