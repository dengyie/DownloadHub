export const categories = [
  {id:'all',name:'全部资源',icon:'layers'},
  {id:'tools',name:'开发工具',icon:'code'},
  {id:'android',name:'Android 应用',icon:'monitor'},
  {id:'scripts',name:'实用脚本',icon:'terminal'},
  {id:'commerce',name:'卡密资源',icon:'lock'},
];
export const categoryName = id => categories.find(category=>category.id===id)?.name || '公开资源';
export const categoryIcon = id => categories.find(category=>category.id===id)?.icon || 'layers';
export function filterPublic(resources, category, query) {
  if(category==='commerce'||category.startsWith('shop-'))return [];
  const words=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return resources.filter(item=>(category==='all'||item.category===category)&&words.every(word=>`${item.name} ${item.description} ${item.platform} ${item.filename} ${item.version}`.toLocaleLowerCase().includes(word)));
}
export function flattenCategories(items) {
  const result=[];
  const visit=list=>list.forEach(item=>{if(item&&Number.isInteger(Number(item.id))&&Number(item.id)>0){result.push({id:`shop-${item.id}`,name:String(item.name),icon:'lock'});if(Array.isArray(item.children))visit(item.children);else if(Array.isArray(item.child))visit(item.child);}});
  if(Array.isArray(items))visit(items);
  return result;
}
