/**
 * 站点公告：管理后台「启动重要公告」发布的那一条。
 *
 * 它本来只给启动器启动时弹窗用，现在官网和论坛打开时也要显示，
 * 所以单独开一个匿名可读的接口，前端每个页面都来问一次。
 *
 * 挂在 /api/app/ 下：和版本发布一样不带「论坛」语义，也绕开人机验证门禁，
 * 官网游客、启动器和论坛页面都能直接取到；没发布时返回 null，前端什么都不显示。
 */
import { getActiveImportantAnnouncement } from '../lib/announcements.js';

export default function register(router) {
  router.get('/api/app/important-announcement', async () => ({
    important: getActiveImportantAnnouncement(),
  }));
}
