/**
 * ============================================================================
 *  【文件总览】src/tools/MCPTool/classifyForCollapse.ts —— 「这个 MCP 结果能折叠吗」
 * ============================================================================
 *
 *  ★★ 一句话定位（本文件在干一件很特别的事）★★
 *
 *  判断一个 MCP 工具的**调用结果**属不属于「查询 / 读取」，
 *  从而决定它在终端里能不能被**折叠（collapse）**成一行摘要。
 *
 *      能折叠（isSearch / isRead = true）：
 *          slack_search_public      → 结果通常很长，折叠成「找到 12 条消息」
 *          jira_get_issue           → 折叠成一行，Ctrl+O 展开
 *          list_commits             → 同上
 *
 *      不能折叠（两个都是 false）：
 *          slack_post_message       → 结果很短（就一个链接），折叠反而丢信息
 *          create_issue / update_* / delete_*  → 「写」操作，结果必须让用户看清楚
 *
 *  为什么要有这个判断？因为 MCP 是**开放生态**，我们拿不到可靠的语义标记：
 *    - MCP 协议确实有 annotations.readOnlyHint，但**绝大多数 server 不填**，
 *      填了也只区分「读/写」，区分不了「读一行」和「读一万行」；
 *    - 而「能不能折叠」取决于**结果有多长多结构化**，这跟读/写不是一回事。
 *  所以只能笨办法：维护一张**白名单（allowlist）**，把常见的 server 工具名逐个登记。
 *
 * ---------------------------------------------------------------------------
 *  【在架构中的位置】
 *  ---------------------------------------------------------------------------
 *      src/services/mcp/client.ts
 *        └─ 为每个 MCP tool 生成工具实例时：
 *              isSearchOrReadCommand() {
 *                return classifyMcpToolForCollapse(client.name, tool.name)  ← ★ 本文件
 *              }
 *                    └─ 主循环 / UI 据此决定渲染成「折叠摘要」还是「完整输出」
 *
 *  注意它与 MCPTool 目录其它文件的关系：
 *      本文件     → 提供**分类依据**（纯数据 + 一个纯函数，零依赖、零副作用）
 *      UI.tsx     → 消费分类结果，决定怎么画
 *      MCPTool.ts → 模板，不含分类逻辑
 *  MCP 的其它能力（连接、鉴权、执行）都在 src/services/mcp/。
 *
 * ---------------------------------------------------------------------------
 *  【本文件包含什么】
 *  ---------------------------------------------------------------------------
 *   1. SEARCH_TOOLS   约 90 个「搜索类」工具名的 Set
 *   2. READ_TOOLS     约 300 个「读取类」工具名的 Set
 *   3. normalize()    把工具名统一成 snake_case 小写
 *   4. classifyMcpToolForCollapse()  唯一导出：查两张表，返回 { isSearch, isRead }
 *
 * ---------------------------------------------------------------------------
 *  【★ 分类逻辑的完整拆解（本文件的灵魂）★】
 *  ---------------------------------------------------------------------------
 *
 *  第 0 步：**为什么只按「工具名」匹配，不按 server 名？**
 *      因为同一个 server 在不同环境里名字会变：
 *          本地装的叫 "slack"，claude.ai 托管的叫 "claude_ai_Slack"
 *      但**工具名是稳定的**（都是 slack_search_public）。
 *      所以函数签名里第一个参数 `_serverName` 加了下划线 —— 收下了但不用。
 *      （保留这个参数是为了让调用方写法自然、将来想用也容易改。）
 *
 *  第 1 步：**归一化（normalize）** —— 解决命名风格不统一
 *      同一个工具在不同 server 里可能写成三种风格：
 *          searchJiraIssuesUsingJql   （camelCase，Atlassian 官方）
 *          search-jira-issues-using-jql（kebab-case，Notion/Todoist 风格）
 *          search_jira_issues_using_jql（snake_case，GitHub 风格）
 *      normalize 三步把它们全变成 snake_case 小写：
 *          ① `([a-z])([A-Z])` → `$1_$2`   在小写→大写之间插下划线（拆 camelCase）
 *          ② `-` → `_`                     连字符转下划线
 *          ③ toLowerCase()                 统一小写
 *      于是三种写法匹配到同一个 key。这是**唯一**的字符串处理，非常便宜。
 *
 *  第 2 步：**查两张 Set** —— 白名单匹配
 *      isSearch = SEARCH_TOOLS.has(normalized)
 *      isRead   = READ_TOOLS.has(normalized)
 *      注意这是**两个独立的布尔**，不是互斥的三分类：
 *          理论上一个工具可以同时 isSearch 和 isRead（虽然列表里没有重叠）。
 *      Set 的 has() 是 O(1)，比数组 includes() 的 O(n) 快，
 *      而这个函数在每次工具调用前都会跑，所以选 Set。
 *
 *  第 3 步：**保守兜底** —— 不认识就**不折叠**
 *      查不到 → 两个都是 false → 不折叠 → 完整显示。
 *      为什么「不折叠」是安全的默认？
 *        折叠是为了省屏幕和上下文，代价是**可能藏住信息**。
 *        折叠一个其实很短的结果 → 用户什么都没看到（轻微损失）
 *        不折叠一个其实很长的结果 → 刷屏（也是轻微损失）
 *        但对 MCP 这种未知生态，**藏住信息更危险**：万一结果里有
 *        「删除成功 / 失败原因」这种关键信息，被折叠了用户就不知道了。
 *      所以对未知工具一律「不折叠」—— 宁可啰嗦，不可隐瞒。
 *
 * ---------------------------------------------------------------------------
 *  【怎么读那两张大表】
 *  ---------------------------------------------------------------------------
 *  两张表都按「server / 生态」分组，每组前面有注释标明来源，例如：
 *      // Slack (hosted + @modelcontextprotocol/server-slack)
 *      // GitHub (github/github-mcp-server)
 *      // Datadog (mcp.datadoghq.com)
 *  每组内部按功能排列。表里还有几条**反向**注释值得留意：
 *      // (git has no search verbs)
 *      // (pagerduty reads all use get_/list_, no search verbs)
 *  这是在说明「为什么这个 server 在 SEARCH_TOOLS 里是空的」——
 *  免得后来者以为漏了而误加。
 *
 *  另外注意 `'search'` 和 `'fetch'` 这种**极短**的 key：
 *      Notion 的工具就叫 `search` / `fetch`（kebab 风格归一化后如此）。
 *      它们没有前缀，冲突风险最高，但因为是精确匹配（不是前缀/包含匹配），
 *      所以不会误伤别的 server 的 search_xxx。这也是**不用 startsWith('search')**
 *      这种模糊匹配的原因：模糊匹配会让「未知 server 的 search_foo」被误判为可折叠。
 *
 * ---------------------------------------------------------------------------
 *  【这个设计的取舍（值得思考）】
 *  ---------------------------------------------------------------------------
 *   优点：
 *     - 零依赖、零 IO、纯函数，可以在任何地方安全调用（包括同步渲染路径）
 *     - 判断结果稳定可预测（同一工具名永远同一结果），易于测试和回归
 *     - 新加一个工具只需往表里加一行，不动逻辑
 *   缺点（诚实地说）：
 *     - **需要人工维护**：MCP 生态有几千个 server，这张表只覆盖了最常见的几十个，
 *       新出的 server 一律「不折叠」，直到有人来登记
 *     - 无法感知「同一个工具这次返回了 3 行还是 3000 行」——
 *       分类只看工具名，不看实际结果长度（这是「静态分类」的固有限制）
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查（Java 工程师视角）】
 *  ---------------------------------------------------------------------------
 *   - `new Set([...])` + `.has(x)`
 *                          Set ≈ Java 的 HashSet，has() ≈ contains()，都是 O(1)。
 *                          本文件两个 Set 都是**模块级常量**，只构造一次，
 *                          之后每次调用只是查表，没有分配开销。
 *
 *   - `// prettier-ignore`  格式化工具的指令注释：告诉 prettier **别重排**这段代码。
 *                          为什么？因为下面是一长串**竖直排列**的字符串，
 *                          一行一个便于阅读和 diff；一旦被 prettier 折叠成
 *                          每行好几个，review 时根本看不清增删了哪个工具名。
 *                          ≈ Java 里 `@formatter:off` / `@formatter:on`。
 *
 *   - `const` 声明的 Set 本身不可重新赋值，但**内容可变**（可以 .add）。
 *                          这里不需要 add，纯粹当只读查找表用。
 *
 *   - `function normalize(name: string): string`
 *                          类型标注在**参数后面**和**返回值处**（Java 在前）。
 *                          这是 TS 与 Java 最直观的语法差异。
 *
 *   - `.replace(/([a-z])([A-Z])/g, '$1_$2')`
 *                          正则替换，`$1` `$2` 是**捕获组引用**（Java 里也是 $1）。
 *                          `g` 标志 = 全局替换（Java 的 replaceAll 默认就是全局，
 *                          而 JS 的 replace **只替换第一个**，必须加 g）。
 *                          两个括号就是两个捕获组，分别匹配小写字母和大写字母。
 *
 *   - `_serverName: string`  下划线前缀 = 「我故意不用这个参数」。
 *                          为什么不删掉？因为调用方传的是
 *                          `classifyMcpToolForCollapse(client.name, tool.name)`，
 *                          保留第一个参数位能让调用点自解释、也方便将来启用。
 *
 *   - 返回值 `{ isSearch: boolean; isRead: boolean }`
 *                          内联的**结构化类型**（没起名字的 type）。
 *                          ≈ Java 里为了两个 boolean 专门建一个 record，
 *                          在 TS 里直接写在返回类型位置就行。
 *
 *   - 为什么不用 enum / 联合类型做分类结果？
 *                          因为「可搜索」和「可读取」是**两个独立维度**，
 *                          用两个 boolean 表达比三态 enum 更贴合实际
 *                          （也便于将来加第三个维度而不破坏调用方）。
 *
 * Classify an MCP tool as a search/read operation for UI collapsing.
 * Returns { isSearch: false, isRead: false } for tools that should not
 * collapse (e.g., send_message, create_*, update_*).
 *
 * Uses explicit per-tool allowlists for the most common MCP servers.
 * Tool names are stable across installs (even when the server name varies,
 * e.g., "slack" vs "claude_ai_Slack"), so matching is keyed on the tool
 * name alone after normalizing camelCase/kebab-case to snake_case.
 * Unknown tool names don't collapse (conservative).
 */

// prettier-ignore
// 【中文补充】搜索类白名单：这些工具的结果通常**很长且高度结构化**
// （一列表格、一堆命中项），最适合折叠成「找到 N 条」+ Ctrl+O 展开。
//
// 之所以一条一条竖着写、且加了 prettier-ignore：
//   这样每次新增/删除一个工具名，git diff 都只有干净的一行，review 极方便。
//   如果让 prettier 把几十个字符串折叠成两三行，改动就完全看不出来了。
const SEARCH_TOOLS = new Set([
  // Slack (hosted + @modelcontextprotocol/server-slack)
  'slack_search_public',
  'slack_search_public_and_private',
  'slack_search_channels',
  'slack_search_users',
  // GitHub (github/github-mcp-server)
  'search_code',
  'search_repositories',
  'search_issues',
  'search_pull_requests',
  'search_orgs',
  'search_users',
  // Linear (mcp.linear.app)
  'search_documentation',
  // Datadog (mcp.datadoghq.com)
  'search_logs',
  'search_spans',
  'search_rum_events',
  'search_audit_logs',
  'search_monitors',
  'search_monitor_groups',
  'find_slow_spans',
  'find_monitors_matching_pattern',
  // Sentry (getsentry/sentry-mcp)
  'search_docs',
  'search_events',
  'search_issue_events',
  'find_organizations',
  'find_teams',
  'find_projects',
  'find_releases',
  'find_dsns',
  // Notion (mcp.notion.com — kebab-case, normalized)
  'search',
  // Gmail (claude.ai hosted)
  'gmail_search_messages',
  // Google Drive (claude.ai hosted + @modelcontextprotocol/server-gdrive)
  'google_drive_search',
  // Google Calendar (claude.ai hosted)
  'gcal_find_my_free_time',
  'gcal_find_meeting_times',
  'gcal_find_user_emails',
  // Atlassian/Jira (mcp.atlassian.com — camelCase, normalized)
  'search_jira_issues_using_jql',
  'search_confluence_using_cql',
  'lookup_jira_account_id',
  // Community Atlassian (sooperset/mcp-atlassian)
  'confluence_search',
  'jira_search',
  'jira_search_fields',
  // Asana (mcp.asana.com)
  'asana_search_tasks',
  'asana_typeahead_search',
  // Filesystem (@modelcontextprotocol/server-filesystem)
  'search_files',
  // Memory (@modelcontextprotocol/server-memory)
  'search_nodes',
  // Brave Search
  'brave_web_search',
  'brave_local_search',
  // Git (mcp-server-git)
  // (git has no search verbs)
  // Grafana (grafana/mcp-grafana)
  'search_dashboards',
  'search_folders',
  // PagerDuty
  // (pagerduty reads all use get_/list_, no search verbs)
  // Supabase
  'search_docs',
  // Stripe
  'search_stripe_resources',
  'search_stripe_documentation',
  // PubMed (claude.ai hosted + community)
  'search_articles',
  'find_related_articles',
  'lookup_article_by_citation',
  'search_papers',
  'search_pubmed',
  'search_pubmed_key_words',
  'search_pubmed_advanced',
  'pubmed_search',
  'pubmed_mesh_lookup',
  // Firecrawl
  'firecrawl_search',
  // Exa
  'web_search_exa',
  'web_search_advanced_exa',
  'people_search_exa',
  'linkedin_search_exa',
  'deep_search_exa',
  // Perplexity
  'perplexity_search',
  'perplexity_search_web',
  // Tavily
  'tavily_search',
  // Obsidian (MarkusPfundstein)
  'obsidian_simple_search',
  'obsidian_complex_search',
  // MongoDB
  'find',
  'search_knowledge',
  // Neo4j
  'search_memories',
  'find_memories_by_name',
  // Airtable
  'search_records',
  // Todoist (Doist — kebab-case, normalized)
  'find_tasks',
  'find_tasks_by_date',
  'find_completed_tasks',
  'find_projects',
  'find_sections',
  'find_comments',
  'find_project_collaborators',
  'find_activity',
  'find_labels',
  'find_filters',
  // AWS
  'search_documentation',
  'search_catalog',
  // Terraform
  'search_modules',
  'search_providers',
  'search_policies',
])

// prettier-ignore
// 【中文补充】读取类白名单：这些工具是**只读查询**（get_/list_/read_/describe_...），
// 结果可长可短，但因为是只读的，折叠起来不会造成「用户没看见副作用」的风险。
//
// 与 SEARCH_TOOLS 的分工：
//   SEARCH_TOOLS =「搜索」—— 强调**命中一堆结果**
//   READ_TOOLS   =「读取」—— 强调**拿某个东西的内容**
// 两者在 UI 上的处理可能略有差异（比如摘要措辞不同），所以分开存而不是合成一张表。
//
// 注意表里出现了 `'query'`（Postgres）、`'find'`（MongoDB）、`'count'`（MongoDB）
// 这种**极短且极其通用**的 key。它们能安全存在，靠的就是**精确匹配**：
// 只有工具名**恰好**是 query 才命中，别的 server 的 query_metrics 不会误伤。
// 如果哪天改成 startsWith/contains 匹配，这里立刻就会出 bug —— 改动时务必小心。
const READ_TOOLS = new Set([
  // Slack (hosted + @modelcontextprotocol/server-slack)
  'slack_read_channel',
  'slack_read_thread',
  'slack_read_canvas',
  'slack_read_user_profile',
  'slack_list_channels',
  'slack_get_channel_history',
  'slack_get_thread_replies',
  'slack_get_users',
  'slack_get_user_profile',
  // GitHub (github/github-mcp-server)
  'get_me',
  'get_team_members',
  'get_teams',
  'get_commit',
  'get_file_contents',
  'get_repository_tree',
  'list_branches',
  'list_commits',
  'list_releases',
  'list_tags',
  'get_latest_release',
  'get_release_by_tag',
  'get_tag',
  'list_issues',
  'issue_read',
  'list_issue_types',
  'get_label',
  'list_label',
  'pull_request_read',
  'get_gist',
  'list_gists',
  'list_notifications',
  'get_notification_details',
  'projects_list',
  'projects_get',
  'actions_get',
  'actions_list',
  'get_job_logs',
  'get_code_scanning_alert',
  'list_code_scanning_alerts',
  'get_dependabot_alert',
  'list_dependabot_alerts',
  'get_secret_scanning_alert',
  'list_secret_scanning_alerts',
  'get_global_security_advisory',
  'list_global_security_advisories',
  'list_org_repository_security_advisories',
  'list_repository_security_advisories',
  'get_discussion',
  'get_discussion_comments',
  'list_discussion_categories',
  'list_discussions',
  'list_starred_repositories',
  'get_issue',
  'get_pull_request',
  'list_pull_requests',
  'get_pull_request_files',
  'get_pull_request_status',
  'get_pull_request_comments',
  'get_pull_request_reviews',
  // Linear (mcp.linear.app)
  'list_comments',
  'list_cycles',
  'get_document',
  'list_documents',
  'list_issue_statuses',
  'get_issue_status',
  'list_my_issues',
  'list_issue_labels',
  'list_projects',
  'get_project',
  'list_project_labels',
  'list_teams',
  'get_team',
  'list_users',
  'get_user',
  // Datadog (mcp.datadoghq.com)
  'aggregate_logs',
  'list_spans',
  'aggregate_spans',
  'analyze_trace',
  'trace_critical_path',
  'query_metrics',
  'aggregate_rum_events',
  'list_rum_metrics',
  'get_rum_metric',
  'list_monitors',
  'get_monitor',
  'check_can_delete_monitor',
  'validate_monitor',
  'validate_existing_monitor',
  'list_dashboards',
  'get_dashboard',
  'query_dashboard_widget',
  'list_notebooks',
  'get_notebook',
  'query_notebook_cell',
  'get_profiling_metrics',
  'compare_profiling_metrics',
  // Sentry (getsentry/sentry-mcp)
  'whoami',
  'get_issue_details',
  'get_issue_tag_values',
  'get_trace_details',
  'get_event_attachment',
  'get_doc',
  'get_sentry_resource',
  'list_events',
  'list_issue_events',
  'get_sentry_issue',
  // Notion (mcp.notion.com — kebab-case, normalized)
  'fetch',
  'get_comments',
  'get_users',
  'get_self',
  // Gmail (claude.ai hosted)
  'gmail_get_profile',
  'gmail_read_message',
  'gmail_read_thread',
  'gmail_list_drafts',
  'gmail_list_labels',
  // Google Drive (claude.ai hosted + @modelcontextprotocol/server-gdrive)
  'google_drive_fetch',
  'google_drive_export',
  // Google Calendar (claude.ai hosted)
  'gcal_list_calendars',
  'gcal_list_events',
  'gcal_get_event',
  // Atlassian/Jira (mcp.atlassian.com — camelCase, normalized)
  'atlassian_user_info',
  'get_accessible_atlassian_resources',
  'get_visible_jira_projects',
  'get_jira_project_issue_types_metadata',
  'get_jira_issue',
  'get_transitions_for_jira_issue',
  'get_jira_issue_remote_issue_links',
  'get_confluence_spaces',
  'get_confluence_page',
  'get_pages_in_confluence_space',
  'get_confluence_page_ancestors',
  'get_confluence_page_descendants',
  'get_confluence_page_footer_comments',
  'get_confluence_page_inline_comments',
  // Community Atlassian (sooperset/mcp-atlassian)
  'confluence_get_page',
  'confluence_get_page_children',
  'confluence_get_comments',
  'confluence_get_labels',
  'jira_get_issue',
  'jira_get_transitions',
  'jira_get_worklog',
  'jira_get_agile_boards',
  'jira_get_board_issues',
  'jira_get_sprints_from_board',
  'jira_get_sprint_issues',
  'jira_get_link_types',
  'jira_download_attachments',
  'jira_batch_get_changelogs',
  'jira_get_user_profile',
  'jira_get_project_issues',
  'jira_get_project_versions',
  // Asana (mcp.asana.com)
  'asana_get_attachment',
  'asana_get_attachments_for_object',
  'asana_get_goal',
  'asana_get_goals',
  'asana_get_parent_goals_for_goal',
  'asana_get_portfolio',
  'asana_get_portfolios',
  'asana_get_items_for_portfolio',
  'asana_get_project',
  'asana_get_projects',
  'asana_get_project_sections',
  'asana_get_project_status',
  'asana_get_project_statuses',
  'asana_get_project_task_counts',
  'asana_get_projects_for_team',
  'asana_get_projects_for_workspace',
  'asana_get_task',
  'asana_get_tasks',
  'asana_get_stories_for_task',
  'asana_get_teams_for_workspace',
  'asana_get_teams_for_user',
  'asana_get_team_users',
  'asana_get_time_period',
  'asana_get_time_periods',
  'asana_get_user',
  'asana_get_workspace_users',
  'asana_list_workspaces',
  // Filesystem (@modelcontextprotocol/server-filesystem)
  'read_file',
  'read_text_file',
  'read_media_file',
  'read_multiple_files',
  'list_directory',
  'list_directory_with_sizes',
  'directory_tree',
  'get_file_info',
  'list_allowed_directories',
  // Memory (@modelcontextprotocol/server-memory)
  'read_graph',
  'open_nodes',
  // Postgres (@modelcontextprotocol/server-postgres)
  'query',
  // SQLite (@modelcontextprotocol/server-sqlite)
  'read_query',
  'list_tables',
  'describe_table',
  // Git (mcp-server-git)
  'git_status',
  'git_diff',
  'git_diff_unstaged',
  'git_diff_staged',
  'git_log',
  'git_show',
  'git_branch',
  // Grafana (grafana/mcp-grafana)
  'list_teams',
  'list_users_by_org',
  'get_dashboard_by_uid',
  'get_dashboard_summary',
  'get_dashboard_property',
  'get_dashboard_panel_queries',
  'run_panel_query',
  'list_datasources',
  'get_datasource',
  'get_query_examples',
  'query_prometheus',
  'query_prometheus_histogram',
  'list_prometheus_metric_metadata',
  'list_prometheus_metric_names',
  'list_prometheus_label_names',
  'list_prometheus_label_values',
  'query_loki_logs',
  'query_loki_stats',
  'query_loki_patterns',
  'list_loki_label_names',
  'list_loki_label_values',
  'list_incidents',
  'get_incident',
  'list_sift_investigations',
  'get_sift_investigation',
  'get_sift_analysis',
  'list_oncall_schedules',
  'get_oncall_shift',
  'get_current_oncall_users',
  'list_oncall_teams',
  'list_oncall_users',
  'list_alert_groups',
  'get_alert_group',
  'get_annotations',
  'get_annotation_tags',
  'get_panel_image',
  // PagerDuty (PagerDuty/pagerduty-mcp-server)
  'list_incidents',
  'get_incident',
  'get_outlier_incident',
  'get_past_incidents',
  'get_related_incidents',
  'list_incident_notes',
  'list_incident_workflows',
  'get_incident_workflow',
  'list_services',
  'get_service',
  'list_team_members',
  'get_user_data',
  'list_schedules',
  'get_schedule',
  'list_schedule_users',
  'list_oncalls',
  'list_log_entries',
  'get_log_entry',
  'list_escalation_policies',
  'get_escalation_policy',
  'list_event_orchestrations',
  'get_event_orchestration',
  'list_status_pages',
  'get_status_page_post',
  'list_alerts_from_incident',
  'get_alert_from_incident',
  'list_change_events',
  'get_change_event',
  // Supabase (supabase-community/supabase-mcp)
  'list_organizations',
  'get_organization',
  'get_cost',
  'list_extensions',
  'list_migrations',
  'get_logs',
  'get_advisors',
  'get_project_url',
  'get_publishable_keys',
  'generate_typescript_types',
  'list_edge_functions',
  'get_edge_function',
  'list_storage_buckets',
  'get_storage_config',
  // Stripe (stripe/agent-toolkit)
  'get_stripe_account_info',
  'retrieve_balance',
  'list_customers',
  'list_products',
  'list_prices',
  'list_invoices',
  'list_payment_intents',
  'list_subscriptions',
  'list_coupons',
  'list_disputes',
  'fetch_stripe_resources',
  // PubMed (claude.ai hosted + community)
  'get_article_metadata',
  'get_full_text_article',
  'convert_article_ids',
  'get_copyright_status',
  'download_paper',
  'list_papers',
  'read_paper',
  'get_paper_fulltext',
  'get_pubmed_article_metadata',
  'download_pubmed_pdf',
  'pubmed_fetch',
  'pubmed_pmc_fetch',
  'pubmed_spell',
  'pubmed_cite',
  'pubmed_related',
  // BigQuery (claude.ai hosted + community)
  'bigquery_query',
  'bigquery_schema',
  'list_dataset_ids',
  'list_table_ids',
  'get_dataset_info',
  'get_table_info',
  // Firecrawl
  'firecrawl_scrape',
  'firecrawl_map',
  'firecrawl_crawl',
  'firecrawl_check_crawl_status',
  'firecrawl_extract',
  // Exa
  'get_code_context_exa',
  'company_research_exa',
  'crawling_exa',
  'deep_researcher_check',
  // Perplexity
  'perplexity_ask',
  'perplexity_research',
  'perplexity_reason',
  // Tavily
  'tavily_extract',
  'tavily_crawl',
  'tavily_map',
  'tavily_research',
  // Obsidian (MarkusPfundstein)
  'obsidian_list_files_in_vault',
  'obsidian_list_files_in_dir',
  'obsidian_get_file_contents',
  'obsidian_batch_get_file_contents',
  'obsidian_get_periodic_note',
  'obsidian_get_recent_periodic_notes',
  'obsidian_get_recent_changes',
  // Figma (GLips/Figma-Context-MCP)
  'get_figma_data',
  'download_figma_images',
  // Playwright (microsoft/playwright-mcp)
  'browser_console_messages',
  'browser_network_requests',
  'browser_take_screenshot',
  'browser_snapshot',
  'browser_get_config',
  'browser_route_list',
  'browser_cookie_list',
  'browser_cookie_get',
  'browser_localstorage_list',
  'browser_localstorage_get',
  'browser_sessionstorage_list',
  'browser_sessionstorage_get',
  'browser_storage_state',
  // Puppeteer (@modelcontextprotocol/server-puppeteer)
  'puppeteer_screenshot',
  // MongoDB
  'list_databases',
  'list_collections',
  'collection_indexes',
  'collection_schema',
  'collection_storage_size',
  'db_stats',
  'explain',
  'mongodb_logs',
  'aggregate',
  'count',
  'export',
  // Neo4j
  'get_neo4j_schema',
  'read_neo4j_cypher',
  'list_instances',
  'get_instance_details',
  'get_instance_by_name',
  // Elasticsearch (elastic)
  'list_indices',
  'get_mappings',
  'esql',
  'get_shards',
  // Airtable
  'list_records',
  'list_bases',
  'get_record',
  // Todoist (Doist — kebab-case, normalized)
  'get_productivity_stats',
  'get_overview',
  'fetch_object',
  'user_info',
  'list_workspaces',
  'view_attachment',
  // AWS (awslabs/mcp)
  'get_available_services',
  'read_documentation',
  'read_sections',
  'recommend',
  'analyze_log_group',
  'analyze_metric',
  'describe_log_groups',
  'get_active_alarms',
  'get_alarm_history',
  'get_metric_data',
  'get_metric_metadata',
  // Kubernetes
  'kubectl_get',
  'kubectl_describe',
  'kubectl_logs',
  'kubectl_context',
  'explain_resource',
  'list_api_resources',
  'namespaces_list',
  'nodes_log',
  'nodes_top',
  'pods_get',
  'pods_list',
  'pods_list_in_namespace',
  'pods_log',
  'pods_top',
  'resources_get',
  'resources_list',
])

/**
 * 【中文补充】把工具名的**命名风格**统一成 snake_case 小写。
 *
 * 为什么必须归一化？因为 MCP 生态里同一个语义的工具，命名风格五花八门：
 *
 *     searchJiraIssuesUsingJql      camelCase   （Atlassian 官方 server）
 *     search-jira-issues-using-jql  kebab-case  （Notion / Todoist 风格）
 *     search_jira_issues_using_jql  snake_case  （GitHub 风格）
 *
 * 不归一化的话，白名单里就得把三种写法都登记一遍（维护量 ×3，还容易漏）。
 * 归一化后三者都变成 `search_jira_issues_using_jql`，表里只写一次。
 *
 * 三步各自的作用：
 *   ① `.replace(/([a-z])([A-Z])/g, '$1_$2')`
 *        在「小写字母紧跟大写字母」的地方插入下划线 → 拆开 camelCase
 *        `searchJira` → `search_Jira`
 *        注意只处理「小写→大写」这一种边界，所以连续大写的缩写
 *        （比如 `getHTTPResponse`）不会被拆开 —— 这是**已知且可接受**的简化，
 *        因为 MCP 工具名里连续大写缩写的情况很少见。
 *   ② `.replace(/-/g, '_')`   连字符转下划线 → 处理 kebab-case
 *   ③ `.toLowerCase()`        统一小写 → 消除大小写差异
 *
 * @param name 原始工具名（任意命名风格）
 * @returns 归一化后的 snake_case 小写字符串
 */
function normalize(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
}

/**
 * 【中文补充】★ 本文件唯一对外的函数：判断一个 MCP 工具的结果能否被折叠显示。
 *
 * 调用方（src/services/mcp/client.ts）：
 *      isSearchOrReadCommand() {
 *        return classifyMcpToolForCollapse(client.name, tool.name)
 *      }
 *
 * 判定流程：
 *   ① 把 toolName 归一化成 snake_case 小写
 *   ② 分别在 SEARCH_TOOLS / READ_TOOLS 两张白名单里**精确**查找
 *   ③ 返回两个**独立**的布尔值（不是三选一的枚举）
 *
 * 三个必须记住的约定：
 *   - **只看工具名，不看 server 名**：因为同一个 server 在不同环境名字会变
 *     （"slack" vs "claude_ai_Slack"），而工具名稳定。所以第一个参数被忽略。
 *   - **精确匹配，不是前缀/包含匹配**：避免把未知 server 的 search_xxx 误判为可折叠。
 *   - **查不到就返回 false / false（保守）**：不认识的工具一律不折叠，
 *     宁可啰嗦也不能把关键信息藏起来。
 *
 * 性能：Set.has() 是 O(1)，两个 Set 都是模块级常量只构造一次，
 *       所以即使每次工具调用都跑一遍也几乎没有开销。
 *
 * @param _serverName MCP server 名（**当前未使用**，保留是为了语义完整与将来扩展）
 * @param toolName    工具名（如 'slack_search_public'、'searchJiraIssuesUsingJql'）
 * @returns { isSearch, isRead }
 *          isSearch = true 表示这是「搜索类」工具，结果通常长而结构化；
 *          isRead   = true 表示这是「读取类」工具，结果可以折叠；
 *          两者都 false 表示「不折叠，完整展示」（含所有未知工具）
 */
export function classifyMcpToolForCollapse(
  _serverName: string,
  toolName: string,
): { isSearch: boolean; isRead: boolean } {
  const normalized = normalize(toolName)
  return {
    isSearch: SEARCH_TOOLS.has(normalized),
    isRead: READ_TOOLS.has(normalized),
  }
}
