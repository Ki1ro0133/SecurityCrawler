const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { convertHtmlToMarkdown } = require('./utils/markdown');
const { generateSingleArticleMarkdown, generateIndexMarkdown, generateFileName } = require('./utils/formatter');
const { writeArticleMarkdown, writeRealtimeSummary, writeFinalSummaryAndFailures } = require('./utils/files');

class XianzhiCrawler {
    constructor(options = {}) {
        this.baseUrl = 'https://xz.aliyun.com/news';
        // 过滤时间：支持 startDate/endDate 或单一 targetDate
        this.startDate = options.startDate ? new Date(options.startDate) : null;
        this.endDate = options.endDate ? new Date(options.endDate) : null;
        this.targetDate = options.targetDate ? new Date(options.targetDate) : (this.startDate || null);
        this.articles = [];
        this.browser = null;
        this.page = null;
        this.fetchFullContent = options.fetchFullContent !== false; // 是否获取完整文章内容，默认为true
        this.maxPages = options.maxPages || 1; // 最大爬取页数
        this.debugSaved = false; // 调试标志
        this.imagesOnly = !!options.imagesOnly; // 仅进行本地图片下载
        this.image = !!options.image; // 抓取完成后是否本地化图片
        this.aborted = false; // 中断标志（Ctrl-C）
        this._onSigint = null;
        this._onSigterm = null;
        this.concurrency = Number(options.concurrency) > 0 ? Number(options.concurrency) : 3; // 并发抓取文章详情
        this.failures = []; // 失败记录
        this._summaryUpdateCounter = 0; // 汇总更新节流计数器
        this._seenKeys = new Set(); // 去重键（link 优先）
        this.onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : null; // 事件回调
    }

    emit(event, payload = {}) {
        try {
            if (this.onUpdate) this.onUpdate(event, payload);
        } catch (_) {}
    }

    async init() {
        console.log('启动浏览器...');
        this.browser = await chromium.launch({ 
            headless: true, // 设为false可以看到浏览器操作过程
        });
        
        const context = await this.browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1920, height: 1080 }
        });
        
        this.page = await context.newPage();
    }

    async navigateToNews() {
        console.log('访问先知社区新闻页面...');
        try {
            await this.page.goto(this.baseUrl, { 
                referer: "https://xz.aliyun.com/",
                waitUntil: 'domcontentloaded'
            });
            
            console.log('页面加载完成');
            
            // 点击社区板块标签
            try {
                const communityTab = this.page.locator('text=社区板块').first();
                if (await communityTab.isVisible({ timeout: 5000 })) {
                    console.log('找到社区板块标签，点击切换...');
                    await communityTab.click();
                    // 等待社区板块标签被选中
                    await this.page.waitForLoadState("load");
                    console.log('已切换到社区板块');
                } else {
                    console.log('未找到社区板块标签，可能已经在社区板块页面');
                }
            } catch (error) {
                console.log('点击社区板块标签失败:', error.message);
            }
            
        } catch (error) {
            throw new Error(`导航到新闻页面失败: ${error.message}`);
        }
    }

    async scrapeArticles() {
        console.log('开始爬取文章...');

        let hasMorePages = true;
        let currentPage = 1;
        let totalArticles = 0;

        while (hasMorePages && currentPage <= this.maxPages) {
            if (this.aborted) {
                console.log('检测到中断，停止爬取');
                break;
            }

            console.log(`\n=== 爬取第 ${currentPage} 页 ===`);

            // 获取当前页面的文章
            const articlesOnPage = await this.extractArticlesFromPage();
            if (articlesOnPage.length === 0) {
                console.log('当前页面没有找到文章，停止爬取');
                break;
            }

            // 筛选文章（支持时间范围）
            const filteredArticles = articlesOnPage.filter(article => {
                if (!article.publishTime) return false;
                try {
                    const articleDate = new Date(article.publishTime);
                    let include = true;
                    if (this.startDate) include = include && (articleDate >= this.startDate);
                    if (this.endDate) include = include && (articleDate <= this.endDate);
                    if (!this.startDate && !this.endDate && this.targetDate) {
                        include = include && (articleDate > this.targetDate);
                    }
                    return include;
                } catch (error) {
                    console.log(`解析时间失败: ${article.publishTime}`);
                    return false;
                }
            });

            if (this.fetchFullContent) {
                // 使用简单并发池抓取详情
                const poolSize = Math.max(1, this.concurrency);
                let idx = 0;
                const runOne = async () => {
                    while (idx < filteredArticles.length && !this.aborted) {
                        const i = idx++;
                        const item = filteredArticles[i];
                        // 去重（优先使用 link 作为 key）
                        const key = (item.link && item.link.trim()) || `${(item.title || '').trim()}|${item.publishTime || ''}`;
                        if (this._seenKeys.has(key)) {
                            console.log('🔁 重复文章，跳过抓取与统计');
                            continue;
                        }
                        try {
                            console.log(`获取第 ${i + 1}/${filteredArticles.length} 篇文章的完整内容...`);
                            const articleData = await this.fetchArticleContentWithRetry(item.link, 1);
                            item.content = articleData.content;
                            if (articleData.title && articleData.title !== '未知标题' && articleData.title !== '访问失败') {
                                item.title = articleData.title;
                            }
                            const savedFileName = this.aborted ? null : await this.saveArticleImmediately(item, this.articles.length + 1);
                            if (savedFileName && !this.aborted) {
                                // 最终入库前再次去重
                                if (!this._seenKeys.has(key)) {
                                    this._seenKeys.add(key);
                                    this.articles.push(item);
                                    this.emit('article_saved', { fileName: savedFileName, article: item });
                                } else {
                                    console.log('🔁 重复文章，跳过统计');
                                }
                                await this.maybeUpdateSummaryFile();
                                console.log(`📊 已统计: 第 ${this.articles.length} 篇文章`);
                                this.emit('progress', { totalSaved: this.articles.length });
                            }
                        } catch (error) {
                            if (this.aborted) { break; }
                            console.log(`获取文章内容失败: ${error.message}`);
                            this.failures.push({
                                link: item.link,
                                title: (item.title || '').trim() || '未知标题',
                                error: String(error && error.message ? error.message : error)
                            });
                            this.emit('failure', { link: item.link, title: (item.title || '').trim() || '未知标题', error: String(error && error.message ? error.message : error) });
                        }
                    }
                };
                const workers = Array.from({ length: poolSize }, () => runOne());
                await Promise.all(workers);
            } else {
                for (let i = 0; i < filteredArticles.length; i++) {
                    if (this.aborted) { console.log('已中断，停止当前页剩余文章处理'); break; }
                    const item = filteredArticles[i];
                    const key = (item.link && item.link.trim()) || `${(item.title || '').trim()}|${item.publishTime || ''}`;
                    if (this._seenKeys.has(key)) {
                        console.log('🔁 重复文章，跳过抓取与统计');
                        continue;
                    }
                    const savedFileName = await this.saveArticleImmediately(item, this.articles.length + 1);
                    if (savedFileName && !this.aborted) {
                        this._seenKeys.add(key);
                        this.articles.push(item);
                        this.emit('article_saved', { fileName: savedFileName, article: item });
                        await this.maybeUpdateSummaryFile();
                        console.log(`📊 已统计: 第 ${this.articles.length} 篇文章`);
                        this.emit('progress', { totalSaved: this.articles.length });
                    }
                }
            }

            totalArticles += articlesOnPage.length;
            console.log(`第 ${currentPage} 页: 找到 ${articlesOnPage.length} 篇文章，符合条件 ${filteredArticles.length} 篇`);
            console.log(`累计: 总文章 ${totalArticles} 篇，已保存 ${this.articles.length} 篇`);

            if (this.articles.length > 0 && filteredArticles.length > 0) {
                console.log('已处理的最新文章:');
                const recentArticles = this.articles.slice(-Math.min(3, filteredArticles.length));
                recentArticles.forEach(article => {
                    const safeTitle = (article.title || '未知标题').trim();
                    console.log(`  ✅ ${safeTitle.substring(0, 60)}... (${article.publishTime})`);
                });
            }

            const thresholdDate = this.startDate || this.targetDate || null;
            const hasOlderArticles = thresholdDate ? articlesOnPage.some(article => {
                if (!article.publishTime) return false;
                try {
                    const articleDate = new Date(article.publishTime);
                    return articleDate <= thresholdDate;
                } catch (error) {
                    return false;
                }
            }) : false;

            if (hasOlderArticles && currentPage > 3) {
                console.log('发现有文章早于目标日期，且已爬取足够页面，停止爬取');
                break;
            }

            if (this.aborted) { console.log('已中断，不再翻页'); break; }

            hasMorePages = await this.goToNextPage();
            if (hasMorePages) {
                currentPage++;
            }
        }

        console.log(`\n爬取完成！共获取 ${this.articles.length} 篇文章`);
        this.emit('run_page_complete', { totalSaved: this.articles.length });
    }

    async fetchArticleContent(articleUrl) {
        try {
            if (this.aborted) {
                throw new Error('aborted');
            }
            // 在新标签页中打开文章
            const articlePage = await this.browser.newPage();
            // 阻止非必要资源以加速加载
            try {
                await articlePage.route('**/*', (route) => {
                    const req = route.request();
                    const type = req.resourceType();
                    // 核心内容在 HTML 中，阻止图片/媒体/字体/样式以提速；
                    const block = ['image', 'media'];
                    if (block.includes(type)) {
                        return route.abort();
                    }
                    return route.continue();
                });
            } catch (e) {
                // 路由可能在已设置时抛错，忽略
            }
            if (this.aborted) {
                try { await articlePage.close(); } catch {}
                throw new Error('aborted');
            }
            await articlePage.goto(articleUrl, { waitUntil: 'load', timeout: 300000, referer: "https://xz.aliyun.com/" });
            // 进一步等待页面与主体内容，避免过早读取
            try { await articlePage.waitForLoadState('domcontentloaded', { timeout: 10000 }); } catch {}
            try { await articlePage.waitForSelector('.ne-viewer-body', { timeout: 15000 }); } catch {}
            // 页面级滚动触发懒加载/虚拟化渲染
            try {
                await articlePage.evaluate(async () => {
                    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                    for (let i = 0; i < 10; i++) {
                        window.scrollBy(0, Math.max(200, window.innerHeight * 0.8));
                        await sleep(100);
                    }
                    window.scrollTo(0, document.body.scrollHeight);
                    await sleep(150);
                });
            } catch {}
            // 等待主体内容长度短暂稳定
            try {
                await articlePage.waitForFunction(() => {
                    const el = document.querySelector('.ne-viewer-body');
                    if (!el) return false;
                    const len = (el.innerText || '').replace(/\s+/g, '').length;
                    const st = (window.__mdStabilize ||= { last: 0, stable: 0 });
                    if (len === st.last) st.stable++; else { st.last = len; st.stable = 0; }
                    return st.stable >= 2;
                }, { timeout: 4000 });
            } catch {}
            // 提取文章标题
            let title = '';
            try {
                const titleSelectors = [
                    'h1',
                    '.article-title',
                    '.entry-title',
                    '[class*="title"]:first-child',
                    'title'
                ];
                
                for (const selector of titleSelectors) {
                    const titleElement = articlePage.locator(selector).first();
                    if (await titleElement.isVisible({ timeout: 2000 })) {
                        const titleText = await titleElement.textContent();
                        const trimmedTitle = titleText ? titleText.trim() : '';
                        if (trimmedTitle && trimmedTitle.length > 5) {
                            title = trimmedTitle;
                            break;
                        }
                    }
                }
                
                // 从页面标题中提取（作为备选）
                if (!title) {
                    const pageTitle = await articlePage.title();
                    if (pageTitle && pageTitle.includes('-先知社区')) {
                        title = pageTitle.replace('-先知社区', '').trim();
                    }
                }
            } catch (error) {
                console.log('提取文章标题失败:', error.message);
            }
            
            // 提取文章内容 - 获取HTML并转换为Markdown
            let content = '';
            try {
                // 优先使用 ne-viewer-body 获取HTML内容
                const contentElement = articlePage.locator('.ne-viewer-body').first();
                // 等待代码块渲染完成并尽量取消高度限制，滚动以触发完整渲染
                try {
                    await articlePage.waitForSelector('.cm-content', { timeout: 2000 });
                    await articlePage.evaluate(async () => {
                        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                        // 取消高度限制，避免只渲染部分行
                        document.querySelectorAll('.ne-codeblock-height-limit').forEach(el => {
                            el.classList.remove('ne-codeblock-height-limit');
                        });
                        // 解除滚动容器高度限制
                        const scrollers = Array.from(document.querySelectorAll('.cm-scroller'));
                        scrollers.forEach(el => { el.style.maxHeight = 'none'; });
                        // 将代码块滚动到视区触发渲染
                        document.querySelectorAll('.ne-card[data-card-name="codeblock"]').forEach(el => el.scrollIntoView({ block: 'center' }));
                        const countLines = () => document.querySelectorAll('.cm-content .cm-line').length;
                        let prev = countLines();
                        // 多次滚动触发虚拟化渲染更多行，直到行数稳定
                        for (let i = 0; i < 10; i++) {
                            scrollers.forEach(el => { el.scrollTop = el.scrollHeight; });
                            await sleep(160);
                            const curr = countLines();
                            if (curr <= prev) break;
                            prev = curr;
                        }
                        // 将 CodeMirror 代码块转换为静态 pre/code，确保后续 HTML 转换完整
                        const blocks = Array.from(document.querySelectorAll('.ne-card[data-card-name="codeblock"]'));
                        const normalizeLang = (lang) => {
                            const l = (lang || '').toLowerCase();
                            if (l === 'shell') return 'bash';
                            if (l === 'plain' || l === 'plaintext' || l === 'text') return '';
                            return l;
                        };
                        const getLineText = (node) => {
                            let out = '';
                            const walk = (n) => {
                                if (!n) return;
                                if (n.nodeType === 3) {
                                    out += (n.textContent || '');
                                } else if (n.nodeType === 1) {
                                    if (n.tagName && n.tagName.toLowerCase() === 'br') return;
                                    for (let c of n.childNodes) walk(c);
                                }
                            };
                            walk(node);
                            return out.replace(/\u200B/g, '');
                        };
                        blocks.forEach(block => {
                            const modeEl = block.querySelector('[data-codeblock-mode]') || block.querySelector('.cm-content');
                            const lang = normalizeLang(modeEl ? (modeEl.getAttribute('data-codeblock-mode') || modeEl.getAttribute('data-language') || '') : '');
                            const lineEls = block.querySelectorAll('.cm-line');
                            let lines = [];
                            if (lineEls && lineEls.length) {
                                lines = Array.from(lineEls).map(le => getLineText(le));
                            } else {
                                const cmContent = block.querySelector('.cm-content');
                                if (cmContent) {
                                    for (let child of cmContent.childNodes) {
                                        lines.push(getLineText(child));
                                    }
                                } else {
                                    const inner = block.querySelector('.ne-codeblock-inner') || block;
                                    const txt = (inner.textContent || '').replace(/\u200B/g, '');
                                    lines = txt.split(/\r?\n/);
                                }
                            }
                            const codeText = lines.join('\n').replace(/\r\n?/g, '\n');
                            const pre = document.createElement('pre');
                            const code = document.createElement('code');
                            if (lang) code.setAttribute('data-language', lang);
                            code.textContent = codeText;
                            pre.appendChild(code);
                            block.innerHTML = '';
                            block.appendChild(pre);
                        });
                    });
                    // 再给一小段时间让 DOM 稳定
                    await this.sleep(100);
                } catch {}

                const htmlContent = await contentElement.innerHTML();

                // 将html内容保存至本地以供调试
                // fs.writeFileSync(path.join(__dirname, 'debug_article.html'), htmlContent, 'utf8');

                if (htmlContent && htmlContent.length > 100) {
                    // console.log('成功获取 ne-viewer-body HTML内容');
                    content = convertHtmlToMarkdown(htmlContent);
                }
                
                if (!content) {
                    content = '无法获取文章内容';
                }
                
            } catch (error) {
                content = '提取文章内容失败: ' + error.message;
            }
            
            await articlePage.close();
            return {
                title: title.trim() || '未知标题',
                content: content.trim() || '无法获取文章内容'
            };
            
        } catch (error) {
            if (!this.aborted) {
                console.log(`访问文章页面失败: ${error.message}`);
            }
            return {
                title: '访问失败',
                content: this.aborted ? '已中断' : ('访问文章页面失败: ' + error.message)
            };
        }
    }

    // 带重试的获取文章内容
    async fetchArticleContentWithRetry(articleUrl, retries = 1, baseDelay = 800) {
        let attempt = 0;
        let lastErr = null;
        while (attempt <= retries && !this.aborted) {
            try {
                const res = await this.fetchArticleContent(articleUrl);
                // 认为这些情况是失败，需要重试
                if (!res || res.title === '访问失败' || !res.content || /无法获取文章内容|提取文章内容失败/i.test(res.content)) {
                    throw new Error(res && res.title ? res.title : '抓取失败');
                }
                return res;
            } catch (e) {
                lastErr = e;
                if (attempt === retries) break;
                const delay = baseDelay * Math.pow(2, attempt);
                await this.sleep(delay);
                attempt++;
            }
        }
        throw lastErr || new Error('抓取失败');
    }

    sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    async extractArticlesFromPage() {
        console.log('提取当前页面的文章...');
        if (this.aborted) return [];
        await this.page.waitForSelector('li[data-cateid="26"].selected', { timeout: 10000 });
        await this.page.waitForSelector('#news_list .news_item', { timeout: 10000 });
        // 尝试多个选择器以适应不同页面结构
        const articleSelectors = [
            '.news_item',  // 主要选择器：class="news_item"
            'div[class*="news_item"]', // 备用选择器
        ];
        
        let articles = [];
        
        for (const selector of articleSelectors) {
            try {
                if (this.aborted) return articles;
                const elements = await this.page.locator(selector).all();
                if (elements.length > 0) {
                    console.log(`使用选择器 ${selector} 找到 ${elements.length} 个文章元素`);
                    
                    for (let i = 0; i < elements.length; i++) {
                        try {
                            const article = await this.extractArticleInfo(elements[i]);
                            if (article && article.title) {
                                articles.push(article);
                            }
                        } catch (error) {
                            console.log(`提取第 ${i + 1} 个文章时出错: ${error.message}`);
                        }
                    }
                    
                    if (articles.length > 0) {
                        break; // 找到文章就不再尝试其他选择器
                    }
                }
            } catch (error) {
                console.log(`选择器 ${selector} 查找失败: ${error.message}`);
                continue;
            }
        }
        
        return articles;
    }

    async extractArticleInfo(element) {
        try {
            // 提取标题
            let title = '';
            try {
                const newsLinks = await element.locator('a[href*="/news/"]').all();
                
                if (newsLinks.length >= 2) {
                    // 使用第二个链接（通常是文章标题）
                    const titleText = await newsLinks[1].textContent();
                    title = titleText ? titleText.trim() : '';
                } else if (newsLinks.length >= 1) {
                    // 如果只有一个链接，使用第一个
                    const titleText = await newsLinks[0].textContent();
                    title = titleText ? titleText.trim() : '';
                }
            } catch (error) {
                console.log('提取标题失败:', error.message);
            }
            
            // 提取链接
            let link = '';
            try {
                const newsLinks = await element.locator('a[href*="/news/"]').all();
                
                if (newsLinks.length >= 2) {
                    const href = await newsLinks[1].getAttribute('href');
                    if (href) {
                        link = href.startsWith('http') ? href : new URL(href, this.baseUrl).href;
                    }
                } else if (newsLinks.length >= 1) {
                    const href = await newsLinks[0].getAttribute('href');
                    if (href) {
                        link = href.startsWith('http') ? href : new URL(href, this.baseUrl).href;
                    }
                }
            } catch (error) {
                console.log('提取链接失败:', error.message);
            }
            
            // 提取发布时间
            let publishTime = '';
            try {
                const fullText = await element.textContent();
                // 匹配"· 174浏览 · 2025-09-26 08:49"格式
                const timePattern = /·\s*\d+浏览\s*·\s*(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})/;
                const match = fullText.match(timePattern);
                
                if (match) {
                    publishTime = match[1];
                } else {
                    // 备用时间格式
                    const simpleTimePattern = /(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})/;
                    const simpleMatch = fullText.match(simpleTimePattern);
                    if (simpleMatch) {
                        publishTime = simpleMatch[1];
                    }
                }
                publishTime = publishTime.trim();
            } catch (error) {
                console.log('提取时间失败:', error.message);
            }
            
            // 提取分类
            let category = '';
            try {
                const categoryLink = element.locator('a[href*="cate_id="]').first();
                if (await categoryLink.isVisible({ timeout: 1000 })) {
                    const categoryText = await categoryLink.textContent();
                    category = categoryText ? categoryText.trim() : '';
                }
            } catch (error) {
                console.log('提取分类失败:', error.message);
            }
            
            // 提取作者信息
            let author = '';
            try {
                const authorLink = element.locator('a[href*="/users/"]').first();
                if (await authorLink.isVisible({ timeout: 1000 })) {
                    const authorText = await authorLink.textContent();
                    if (authorText) {
                        // 提取用户名（去除"发表于 地区"部分）
                        const lines = authorText.split('\n').filter(line => line.trim());
                        author = lines[0] ? lines[0].trim() : '';
                    }
                }
            } catch (error) {
                console.log('提取作者失败:', error.message);
            }
            
            if (title && title.length > 5) {
                return {
                    title,
                    link,
                    publishTime,
                    category,
                    author,
                    extractedAt: new Date().toISOString()
                };
            }
            
            return null;
        } catch (error) {
            console.log('提取文章信息时出错:', error.message);
            return null;
        }
    }

    async goToNextPage() {
        try {
            if (this.aborted) return false;
            // 查找"下一页"链接
            const nextPageLink = this.page.locator('a:has-text("下一页")').first();
            if (!(await nextPageLink.isVisible({ timeout: 3000 }))) {
                console.log('没有找到下一页链接，已到最后一页');
                return false;
            }
            // 记录翻页前首条文章 href，用于变化判断
            const prevFirstHref = await this.page.evaluate(() => {
                const el = document.querySelector('#news_list .news_item a[href*="/news/"]');
                return el ? el.getAttribute('href') : null;
            });
            console.log('找到下一页链接，正在翻页...');
            await nextPageLink.click();
            // 等待列表发生变化（多数站点是异步渲染），失败则兜底
            try {
                await this.page.waitForFunction((prev) => {
                    const el = document.querySelector('#news_list .news_item a[href*="/news/"]');
                    const href = el ? el.getAttribute('href') : null;
                    return href && href !== prev;
                }, prevFirstHref, { timeout: 8000 });
            } catch (e) {
                try {
                    const href = await nextPageLink.getAttribute('href');
                    if (href && !/^javascript|^#/.test(href)) {
                        const absolute = new URL(href, this.baseUrl).href;
                        await this.page.goto(absolute, { waitUntil: 'domcontentloaded' });
                        await this.page.waitForLoadState('networkidle');
                    } else {
                        await this.page.waitForLoadState('networkidle');
                        await this.page.waitForTimeout(1500);
                    }
                } catch (e2) {
                    console.log('翻页兜底跳转失败:', e2.message);
                }
            }
            return true;
        } catch (error) {
            console.log('翻页失败:', error.message);
            return false;
        }
    }

    async saveArticleImmediately(article, index) {
        try {
            const baseDir = path.resolve(__dirname, '..');
            const { fileName, wrote } = writeArticleMarkdown(
                article,
                baseDir,
                generateSingleArticleMarkdown,
                generateFileName
            );
            console.log(wrote ? `✅ 已保存: ${fileName}` : `⏭️ 已存在，跳过写入: ${fileName}`);
            this.emit('file_written', { fileName, wrote });
            return fileName;
        } catch (error) {
            console.error(`❌ 保存文章 "${(article.title || '未知标题').trim()}" 失败:`, error.message);
            this.emit('failure', { title: (article.title || '未知标题').trim(), error: error.message });
            return null;
        }
    }

    async maybeUpdateSummaryFile(force = false) {
        this._summaryUpdateCounter++;
        if (force || this._summaryUpdateCounter % 3 === 0) {
            await this.updateSummaryFile();
        }
    }

    async updateSummaryFile() {
        try {
            const baseDir = path.resolve(__dirname, '..');
            writeRealtimeSummary(this.articles, this.baseUrl, generateFileName, baseDir);
            this.emit('summary_updated', { totalSaved: this.articles.length });
        } catch (error) {
            console.error(`⚠️ 更新汇总文件失败: ${error.message}`);
            this.emit('failure', { title: '更新汇总文件失败', error: error.message });
        }
    }

    async saveResults() {
        console.log(`\n📋 生成最终汇总报告...`);
        
        if (this.articles.length === 0) {
            console.log('⚠️ 没有成功处理的文章');
            return;
        }
        const baseDir = path.resolve(__dirname, '..');
        const { finalIndexPath, failPath } = writeFinalSummaryAndFailures(
            this.articles,
            this.baseUrl,
            this.failures || [],
            baseDir
        );
        
        console.log(`\n🎉 爬取任务完成！`);
        console.log(`📊 总计处理并保存: ${this.articles.length} 篇文章`);
        console.log(`📁 文章保存位置: papers/ 文件夹`);
        console.log(`📋 实时汇总文件: SUMMARY-REALTIME.md`);
        console.log(`📋 最终汇总文件: ${path.basename(finalIndexPath)}`);
        
        // 生成统计报告
        this.generateReport();
        if (failPath) {
            console.log(`⚠️ 抓取失败 ${this.failures.length} 条，已导出: ${path.basename(failPath)}`);
        }
    }

    generateReport() {
        console.log('\n=== 爬取统计报告 ===');
        console.log(`总文章数: ${this.articles.length}`);
        
        // 按分类统计
        const categoryStats = {};
        this.articles.forEach(article => {
            const cat = article.category || '未分类';
            categoryStats[cat] = (categoryStats[cat] || 0) + 1;
        });
        
        console.log('\n按分类统计:');
        Object.entries(categoryStats)
            .sort((a, b) => b[1] - a[1])
            .forEach(([category, count]) => {
                console.log(`  ${category}: ${count} 篇`);
            });
        
        // 按日期统计
        const dateStats = {};
        this.articles.forEach(article => {
            if (article.publishTime) {
                const date = article.publishTime.split(' ')[0];
                dateStats[date] = (dateStats[date] || 0) + 1;
            }
        });
        
        console.log('\n按日期统计 (前10天):');
        Object.entries(dateStats)
            .sort((a, b) => b[0].localeCompare(a[0]))
            .slice(0, 10)
            .forEach(([date, count]) => {
                console.log(`  ${date}: ${count} 篇`);
            });

        // 最新文章
        console.log('\n最新5篇文章:');
        this.articles
            .sort((a, b) => new Date(b.publishTime) - new Date(a.publishTime))
            .slice(0, 5)
            .forEach((article, index) => {
                console.log(`  ${index + 1}. ${(article.title || '未知标题').trim()} (${article.publishTime})`);
            });
    }

    // ============ Images-only mode helpers ============
    async localizeImagesInPapers() {
        const baseDir = path.resolve(__dirname, '..');
        const papersDir = path.join(baseDir, 'papers');
        const imagesDir = path.join(papersDir, 'images');

        if (!fs.existsSync(papersDir)) {
            fs.mkdirSync(papersDir, { recursive: true });
            console.log('papers 文件夹不存在，已创建（暂无文件可处理）');
            this.emit('image_localize_ready', { created: true });
            return;
        }
        if (!fs.existsSync(imagesDir)) {
            fs.mkdirSync(imagesDir, { recursive: true });
            console.log(`创建文件夹: ${imagesDir}`);
        }

        const all = fs.readdirSync(papersDir).filter(f => f.toLowerCase().endsWith('.md'));
        if (all.length === 0) {
            console.log('papers 下没有 Markdown 文件，跳过');
            this.emit('image_localize_ready', { created: false, totalFiles: 0 });
            this.emit('image_localize_complete', { scanned: 0, downloaded: 0 });
            return;
        }

        console.log(`开始本地化 ${all.length} 个 Markdown 文件中的图片...`);
        this.emit('image_localize_start', { totalFiles: all.length });

        let totalImages = 0;
        let downloaded = 0;
        for (const mdName of all) {
            const mdPath = path.join(papersDir, mdName);
            // 去掉内联 SVG 占位（例如“图片加载失败”图标），避免误识别为需下载图片
            const raw = fs.readFileSync(mdPath, 'utf8').replace(/!\[[^\]]*\]\(data:image\/svg\+xml;[^)]+\)/gi, '');

            // http/https 图片
            const imageRegex = /!\[[^\]]*\]\((https?:[^)\s]+)(?:\s+"[^"]*")?\)/g;
            const tasks = [];
            let match;
            while ((match = imageRegex.exec(raw)) !== null) {
                totalImages++;
                const full = match[0];
                const url = match[1];
                const hashed = this.sha1(url).slice(0, 32);
                const ext = this.inferImageExt(url);
                const fileName = `${hashed}${ext}`;
                const localPath = path.join(imagesDir, fileName);
                const localRel = `images/${fileName}`;
                tasks.push({ full, url, localPath, localRel, ok: false });
            }

            // data:image 图片（支持 base64 与非 base64 载荷）
            const dataRegex = /!\[[^\]]*\]\((data:image\/[a-zA-Z0-9.+-]+(?:;charset=[^;,)]+)?(?:;base64)?,[^)]+)(?:\s+"[^"]*")?\)/g;
            const dataTasks = [];
            while ((match = dataRegex.exec(raw)) !== null) {
                totalImages++;
                const full = match[0];
                const dataUrl = match[1];
                // MIME
                const mimeMatch = /^data:([^;,]+)(?:;charset=[^;,]+)?(?:;base64)?,/i.exec(dataUrl);
                const mime = mimeMatch ? mimeMatch[1].toLowerCase() : 'image/jpeg';
                let ext = '.jpg';
                if (mime.includes('png')) ext = '.png';
                else if (mime.includes('jpeg') || mime.includes('jpg')) ext = '.jpg';
                else if (mime.includes('gif')) ext = '.gif';
                else if (mime.includes('webp')) ext = '.webp';
                else if (mime.includes('bmp')) ext = '.bmp';
                else if (mime.includes('svg')) ext = '.svg';
                else if (mime.includes('x-icon') || mime.includes('vnd.microsoft.icon') || mime.includes('ico')) ext = '.ico';
                const hashed = this.sha1(dataUrl).slice(0, 32);
                const fileName = `${hashed}${ext}`;
                const localPath = path.join(imagesDir, fileName);
                const localRel = `images/${fileName}`;
                dataTasks.push({ full, dataUrl, localPath, localRel, ok: false });
            }

            if (tasks.length === 0 && dataTasks.length === 0) continue;

            // 并发下载当前文件中的图片
            let tIdx = 0;
            const pool = Math.max(1, this.concurrency);
            const worker = async () => {
                while (tIdx < tasks.length) {
                    const i = tIdx++;
                    const t = tasks[i];
                    try {
                        if (!fs.existsSync(t.localPath)) {
                            await this.downloadWithReferer(t.url, t.localPath, 'https://xz.aliyun.com/');
                            downloaded++;
                        }
                        t.ok = true;
                    } catch (e) {
                        console.log(`下载失败: ${t.url} -> ${e.message}`);
                        t.ok = false;
                    }
                }
            };
            await Promise.all(Array.from({ length: pool }, () => worker()));

            // 处理 data:image 写入
            for (const t of dataTasks) {
                try {
                    if (!fs.existsSync(t.localPath)) {
                        const commaIdx = t.dataUrl.indexOf(',');
                        const header = t.dataUrl.substring(0, commaIdx);
                        const payload = t.dataUrl.substring(commaIdx + 1);
                        const isBase64 = /;base64/i.test(header);
                        const buf = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
                        if (buf.length === 0) throw new Error('Empty data');
                        fs.writeFileSync(t.localPath, buf);
                        downloaded++;
                    }
                    t.ok = true;
                } catch (e) {
                    console.log(`写入 data:image 图片失败: ${e.message}`);
                    t.ok = false;
                }
            }

            // 仅对成功的下载/写入做替换
            const replacements = [];
            for (const t of tasks) {
                if (t.ok) {
                    replacements.push({ full: t.full, repl: t.full.replace(t.url, t.localRel) });
                }
            }
            for (const t of dataTasks) {
                if (t.ok) {
                    replacements.push({ full: t.full, repl: t.full.replace(t.dataUrl, t.localRel) });
                }
            }

            if (replacements.length) {
                let updated = raw;
                for (const r of replacements) {
                    updated = updated.split(r.full).join(r.repl);
                }
                fs.writeFileSync(mdPath, updated, 'utf8');
                console.log(`更新 ${mdName}: ${replacements.length} 处图片链接`);
                this.emit('image_localized', { fileName: mdName, replacements: replacements.length });
            }
        }

        console.log(`完成：扫描图片 ${totalImages}，实际下载 ${downloaded}`);
        this.emit('image_localize_complete', { scanned: totalImages, downloaded });
    }

    inferImageExt(urlStr) {
        try {
            const u = new URL(urlStr);
            const p = u.pathname.toLowerCase();
            const m = p.match(/\.(png|jpe?g|gif|webp|svg|bmp|ico)(?:$|\?)/);
            if (m) return `.${m[1] === 'jpg' ? 'jpg' : m[1]}`;
        } catch {}
        return '.jpg';
    }

    sha1(s) {
        return crypto.createHash('sha1').update(s).digest('hex');
    }

    downloadWithReferer(urlStr, destPath, referer = 'https://xz.aliyun.com/', redirectCount = 0) {
        const maxRedirects = 5;
        return new Promise((resolve, reject) => {
            const client = urlStr.startsWith('https') ? https : http;
            const headers = {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
                'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Referer': referer
            };
            const req = client.get(urlStr, { headers }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    if (redirectCount >= maxRedirects) {
                        res.resume();
                        return reject(new Error('Too many redirects'));
                    }
                    const nextUrl = new URL(res.headers.location, urlStr).href;
                    res.resume();
                    return this.downloadWithReferer(nextUrl, destPath, referer, redirectCount + 1).then(resolve).catch(reject);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }
                const ws = fs.createWriteStream(destPath);
                res.pipe(ws);
                ws.on('finish', () => ws.close(resolve));
                ws.on('error', (err) => {
                    fs.unlink(destPath, () => reject(err));
                });
            });
            req.on('error', reject);
            req.setTimeout(30000, () => req.destroy(new Error('Request timeout')));
        });
    }
    async close() {
        if (this.browser) {
            await this.browser.close();
            console.log('浏览器已关闭');
        }
    }

    async run() {
        try {
            this.emit('run_start', { imagesOnly: this.imagesOnly, maxPages: this.maxPages, concurrency: this.concurrency });
            if (this.imagesOnly) {
                await this.localizeImagesInPapers();
                this.emit('run_complete', { imagesOnly: true, totalSaved: this.articles.length, failures: this.failures.length });
                return;
            }

            this.setupSignalHandlers();
            await this.init();
            await this.navigateToNews();
            await this.scrapeArticles();
            await this.saveResults();
            // 抓取完成后，按需本地化图片
            if (this.image && !this.aborted) {
                console.log('开始对已下载文章进行图片本地化...');
                await this.localizeImagesInPapers();
            }
        } catch (error) {
            console.error('爬取过程中出错:', error);
            this.emit('failure', { title: '运行出错', error: String(error && error.message ? error.message : error) });
        } finally {
            if (!this.imagesOnly) {
                await this.close();
            }
            this.teardownSignalHandlers();
            this.emit('run_complete', { imagesOnly: this.imagesOnly, totalSaved: this.articles.length, failures: this.failures.length, aborted: this.aborted });
        }
    }

    setupSignalHandlers() {
        if (this._onSigint || this._onSigterm) return;
        this._onSigint = () => {
            if (!this.aborted) {
                this.aborted = true;
                console.log(`\n⚠️ 收到 Ctrl-C（SIGINT），正在安全停止（已保存 ${this.articles.length} 篇）...`);
            }
        };
        this._onSigterm = () => {
            if (!this.aborted) {
                this.aborted = true;
                console.log(`\n⚠️ 收到 SIGTERM，正在安全停止（已保存 ${this.articles.length} 篇）...`);
            }
        };
        process.on('SIGINT', this._onSigint);
        process.on('SIGTERM', this._onSigterm);
    }

    teardownSignalHandlers() {
        if (this._onSigint) {
            process.off('SIGINT', this._onSigint);
            this._onSigint = null;
        }
        if (this._onSigterm) {
            process.off('SIGTERM', this._onSigterm);
            this._onSigterm = null;
        }
    }
}
module.exports = XianzhiCrawler;