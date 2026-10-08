import http from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixtureAPI} from './tests/fixture-api.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const fixture = process.argv.includes('--fixture');
const readonly = process.argv.includes('--read-only');
const port = Number(process.env.CARDGW_FRONTEND_PORT || 4173);
const origins = {cardgw:process.env.CARDGW_API_ORIGIN,commerce:process.env.COMMERCE_API_ORIGIN,public:process.env.PUBLIC_FILES_ORIGIN};
const mime = {'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.ico':'image/x-icon','.html':'text/html; charset=utf-8'};
const documents = /^(?:\/(?:redeem|help|orders)?\/?|\/resources\/[a-z0-9-]+|\/item\/[1-9]\d*|\/cat\/(?:\d+|recommend)|\/user\/index\/(?:index|item|query)|\/user\/authentication\/(?:login|register|emailForget|phoneForget)|\/user\/dashboard\/index|\/dl\/.+)$/;

function json(response, status, body) {response.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});response.end(JSON.stringify(body));}
async function file(response, filename, head) {
  const info = await stat(filename);
  if (!info.isFile()) throw new Error('not a file');
  response.writeHead(200, {'Content-Type':mime[path.extname(filename)] || 'application/octet-stream','Content-Length':info.size,'Cache-Control':'no-store'});
  if (head) response.end(); else createReadStream(filename).pipe(response);
}
async function proxy(request, response, origin) {
  if (!origin) return json(response,503,{code:503,msg:'尚未连接该 API。请配置本地 API 地址，或使用 npm run dev:fixture 查看测试预览。'});
  if (readonly && !['GET','HEAD'].includes(request.method)) return json(response,403,{code:403,msg:'当前为只读预览，不会提交兑换、订单或账户操作。'});
  const upstream = new URL(origin);
  if (!['http:','https:'].includes(upstream.protocol) || upstream.username || upstream.password) throw new Error('invalid API origin');
  const headers = new Headers();
  for (const name of ['accept','content-type','cookie','user-agent']) if (request.headers[name]) headers.set(name,request.headers[name]);
  const result = await fetch(new URL(request.url, upstream), {method:request.method,headers,redirect:'manual',signal:AbortSignal.timeout(30000),...(!['GET','HEAD'].includes(request.method)?{body:Readable.toWeb(request),duplex:'half'}:{})});
  for (const name of ['content-type','location','cache-control','retry-after','content-disposition']) if (result.headers.has(name)) response.setHeader(name,result.headers.get(name));
  if (result.headers.getSetCookie().length) response.setHeader('Set-Cookie',result.headers.getSetCookie());
  response.writeHead(result.status);
  if (request.method === 'HEAD' || !result.body) response.end(); else Readable.fromWeb(result.body).pipe(response);
}

const server = http.createServer(async (request,response) => {
  response.setHeader('X-Content-Type-Options','nosniff');
  response.setHeader('Referrer-Policy','no-referrer');
  response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  try {
    const url = new URL(request.url,'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    if (/[\\\u0000]/.test(pathname) || pathname.split('/').some(segment=>segment === '..' || segment === '.')) return json(response,400,{code:400,msg:'无效路径'});
    if (fixture && await fixtureAPI(request,response,url)) return;
    if (pathname === '/api/catalog') {
      const resources = JSON.parse(await readFile(path.join(root,'../catalog/public.json'),'utf8'));
      return json(response,200,{code:200,resources});
    }
    if (pathname.startsWith('/api/')) return await proxy(request,response,origins.cardgw);
    if (pathname.startsWith('/user/api/') || pathname.startsWith('/user/captcha/') || pathname === '/user/authentication/logout' || pathname.startsWith('/user/pay/')) return await proxy(request,response,origins.commerce);
    if (pathname.startsWith('/pub/') || pathname.startsWith('/p/')) return await proxy(request,response,origins.public);
    if (!['GET','HEAD'].includes(request.method)) return json(response,405,{code:405,msg:'Method not allowed'});
    if (pathname.startsWith('/ui/dev/')) {
      const relative = pathname.slice('/ui/dev/'.length);
      if (!/\.(js|css)$/.test(relative) || relative.split('/').some(segment=>segment.startsWith('.'))) return json(response,404,{code:404});
      return await file(response,path.join(root,'src',relative),request.method === 'HEAD');
    }
    if (/^\/brand\/(logo\.png|favicon\.ico|apple-touch-icon\.png)$/.test(pathname)) return await file(response,path.join(root,'..',pathname),request.method === 'HEAD');
    if (documents.test(pathname)) {
      let html = (await readFile(path.join(root,'index.html'),'utf8')).replaceAll('__RELEASE__','dev');
      if (fixture) html = html.replace('<html lang="zh-CN">','<html lang="zh-CN" data-fixture="true">');
      if (readonly) html = html.replace('<html lang="zh-CN">','<html lang="zh-CN" data-readonly="true">');
      response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
      response.end(request.method === 'HEAD' ? '' : html);
      return;
    }
    json(response,404,{code:404,msg:'页面不存在'});
  } catch (error) {
    if (!response.headersSent) json(response,error.code === 'ENOENT'?404:502,{code:error.code === 'ENOENT'?404:502,msg:error.code === 'ENOENT'?'文件不存在':'开发服务暂时无法访问 API'});
    else response.end();
  }
});
server.listen(port,'127.0.0.1',()=>console.log(`MangoQWQ frontend: http://127.0.0.1:${port} (${fixture?'synthetic fixture':readonly?'read-only APIs':'configured APIs'})`));
