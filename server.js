const express = require('express');
const path = require('path');
const https = require('https');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const CP=[['#FFF3E0','#C46A00'],['#E1F5EE','#0F6E56'],['#E6F1FB','#185FA5'],['#FBEAF0','#993556'],['#EEEDFE','#534AB7'],['#FFF8EE','#8A4500'],['#EAF3DE','#3B6D11'],['#F1EFE8','#5F5E5A']];
const lc=n=>CP[(n.charCodeAt(0)||0)%CP.length][0];
const lt=n=>CP[(n.charCodeAt(0)||0)%CP.length][1];
const ini=n=>n.trim().split(/\s+/).slice(0,2).map(w=>(w[0]||'').toUpperCase()).join('')||'AF';
const isNew=d=>d&&Date.now()-new Date(d).getTime()<86400000;
const mapType=j=>{const l=(j.working_hours_type?.label||'').toLowerCase();if(l.includes('deltid'))return 'deltid';if(l.includes('distans')||l.includes('hemarbete'))return 'distans';return 'heltid';};

function mapJob(j){
  if(!j||!j.id)return null;
  const name=j.employer?.name||'Okand';
  return{id:j.id,title:j.headline||'Okand titel',company:name,city:j.workplace_address?.municipality||j.workplace_address?.city||'Sverige',region:j.workplace_address?.region||'',type:mapType(j),badge:isNew(j.publication_date)?'new':'',source:'Platsbanken',logo:ini(name),lc:lc(name),lt:lt(name),url:j.webpage_url||j.application_details?.url||'',published:j.publication_date||'',deadline:j.application_deadline||''};
}

function httpsGet(host,p){
  return new Promise((resolve,reject)=>{
    const req=https.request({hostname:host,path:p,method:'GET',headers:{'Accept':'application/json'}},res=>{
      let raw='';res.on('data',c=>raw+=c);res.on('end',()=>resolve({status:res.statusCode,body:raw}));
    });
    req.on('error',reject);req.end();
  });
}

// Soker direkt mot AF for varje request - inga begransningar
async function searchAF(q, offset=0, limit=20){
  const params=new URLSearchParams({limit,offset});
  if(q) params.set('q',q);
  const {status,body}=await httpsGet('jobsearch.api.jobtechdev.se','/search?'+params);
  if(status!==200)throw new Error('AF svarade '+status);
  return JSON.parse(body);
}

// Total antal jobb i Sverige
let totalJobs=0;
async function fetchTotal(){
  try{
    const d=await searchAF('',0,1);
    totalJobs=d.total?.value||0;
    console.log('Totalt i Sverige: '+totalJobs+' jobb');
  }catch(e){console.warn('Total misslyckades:',e.message);}
}
fetchTotal();
setInterval(fetchTotal,30*60*1000);

app.get('/api/jobs',async(req,res)=>{
  try{
    const{q='',city='',type='',page=1,limit=20}=req.query;
    const offset=(parseInt(page)-1)*parseInt(limit);

    // Kombinera q och city till ett sokordet - AF hittar ratt automatiskt
    const parts=[];
    if(q) parts.push(q);
    if(city) parts.push(city);
    const searchQ=parts.join(' ').trim()||undefined;

    const data=await searchAF(searchQ,offset,parseInt(limit));
    let jobs=(data.hits||[]).map(mapJob).filter(Boolean);

    if(type&&type!=='alla'){
      jobs=jobs.filter(j=>j.type===type);
    }

    const total=data.total?.value||0;
    res.json({
      jobs,
      total,
      pages:Math.ceil(total/parseInt(limit)),
      stats:{total:totalJobs||total,sources:340,today:jobs.filter(j=>j.badge==='new').length}
    });
  }catch(e){
    console.error('Fel:',e.message);
    res.status(500).json({error:e.message,jobs:[],total:0,pages:0});
  }
});

app.get('/api/stats',(req,res)=>res.json({total:totalJobs,sources:340}));

app.get('/api/filters',(req,res)=>res.json({
  cities:['Stockholm','Göteborg','Malmö','Borås','Uppsala','Linköping','Örebro','Västerås','Helsingborg','Norrköping','Jönköping','Umeå','Lund','Gävle','Sundsvall','Tranemo','Ulricehamn','Skövde','Halmstad','Växjö'],
  occupations:['Lager','Vård','IT','Butik','Transport','Bygg','Kontor','Restaurang','Lärare','Industri']
}));

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'index.html')));

app.listen(PORT,()=>{
  console.log('\n  Jobbtorget pa http://localhost:'+PORT);
  console.log('  Soker direkt mot AF - alla jobb i Sverige tillgangliga!\n');
});