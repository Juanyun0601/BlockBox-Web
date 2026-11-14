/** 数据库行 → 对外 JSON 形状的统一转换 */

export function boardOut(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    icon: row.icon,
    sort_order: row.sort_order,
    thread_count: row.thread_count || 0,
    post_count: row.post_count || 0,
  };
}

export function authorOut(row, prefix = '') {
  const id = row[`${prefix}id`];
  if (!id) return null;
  return {
    id,
    username: row[`${prefix}username`],
    display_name: row[`${prefix}display_name`] || row[`${prefix}username`],
    avatar: row[`${prefix}avatar`] || '',
  };
}

/** 列表里的摘要：去掉 Markdown 记号，压成一行 */
export function snippetOf(text, limit = 110) {
  if (!text) return '';
  const flat = String(text)
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...flat];
  return chars.length > limit ? chars.slice(0, limit).join('') + '…' : flat;
}

export function threadOut(row, { withSnippet = true } = {}) {
  return {
    id: row.id,
    title: row.title,
    board: row.board_id
      ? { id: row.board_id, slug: row.board_slug, name: row.board_name, icon: row.board_icon || '' }
      : null,
    author: authorOut(row, 'author_'),
    pinned: !!row.pinned,
    locked: !!row.locked,
    views: row.views || 0,
    reply_count: row.reply_count || 0,
    created_at: row.created_at,
    last_post_at: row.last_post_at,
    tags: row.tag_list ? String(row.tag_list).split(',').filter(Boolean) : [],
    last_poster: row.last_username
      ? { username: row.last_username, display_name: row.last_display_name || row.last_username }
      : null,
    // 插件帖：thread 上挂了插件才有（plugin_id 是 thread_plugins 行 id）
    ...(row.tp_id ? { plugin: pluginOut(row) } : {}),
    // 投影帖：thread 上挂了投影文件才有
    ...(row.ts_id ? { schematic: schematicOut(row) } : {}),
    // 资源帖评论数（楼层回复数仍在 reply_count 里，两者互不混算）
    comment_count: row.comment_count || 0,
    ...(withSnippet ? { snippet: snippetOf(row.first_post) } : {}),
    ...(row.bookmarked === undefined ? {} : { bookmarked: !!row.bookmarked }),
  };
}

/** thread_plugins 行 → 卡片展示用的插件 JSON */
export function pluginOut(row) {
  return {
    id: row.tp_id,
    upload_id: row.tp_upload_id,
    plugin_id: row.tp_plugin_id,
    name: row.tp_name,
    version: row.tp_version || '',
    author: row.tp_author || '',
    description: row.tp_description || '',
    icon: row.tp_icon || '',
    file_size: row.tp_file_size || 0,
    downloads: row.tp_downloads || 0,
  };
}

/** thread_schematics 行 → 投影帖详情头部的投影 JSON */
export function schematicOut(row) {
  return {
    id: row.ts_id,
    upload_id: row.ts_upload_id,
    name: row.ts_name || '',
    file_name: row.ts_file_name || '',
    file_size: row.ts_file_size || 0,
    downloads: row.ts_downloads || 0,
  };
}

/**
 * 资源帖评论 → 对外 JSON。
 * 形状刻意和 postOut 的 author 对齐（启动器里两者共用一套用户解析）。
 */
export function commentOut(row) {
  return {
    id: row.id,
    thread_id: row.thread_id,
    content: row.deleted ? '' : row.content,
    deleted: !!row.deleted,
    created_at: row.created_at,
    likes: row.like_count || 0,
    liked: !!row.liked,
    author: row.username
      ? {
          id: row.author_id,
          username: row.username,
          display_name: row.display_name || row.username,
          avatar: row.avatar || '',
          role: row.role || 'user',
          status: row.status || 'active',
          thread_count: row.u_thread_count || 0,
          post_count: row.u_post_count || 0,
          joined_at: row.u_created_at || 0,
        }
      : { id: row.author_id, username: '已注销用户', display_name: '已注销用户', avatar: '' },
  };
}

export function postOut(row) {  return {
    id: row.id,
    thread_id: row.thread_id,
    floor: row.floor,
    parent_post_id: row.parent_post_id || null,
    content: row.deleted ? '' : row.content,
    deleted: !!row.deleted,
    edit_count: row.edit_count || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
    likes: row.like_count || 0,
    liked: !!row.liked,
    children: row.children || [],
    children_count: row.children_count || 0,
    author: row.username
      ? {
          id: row.author_id,
          username: row.username,
          display_name: row.display_name || row.username,
          avatar: row.avatar || '',
          role: row.role || 'user',
          status: row.status || 'active',
          thread_count: row.u_thread_count || 0,
          post_count: row.u_post_count || 0,
          joined_at: row.u_created_at || 0,
        }
      : { id: row.author_id, username: '已注销用户', display_name: '已注销用户', avatar: '' },
  };
}
