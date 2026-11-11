(() => {
"use strict";
const $ = id => document.getElementById(id);
const SUITS = ["♠","♥","♦","♣"], RANKS = ["6","7","8","9","10","J","Q","K","A"];
const RV = Object.fromEntries(RANKS.map((r,i)=>[r,i]));
let peer=null, conn=null, mediaCall=null, localStream=null, remoteStream=null;
let host=false, roomId="", state=null, myHand=[], seat=0, selected=null, connected=false;
let micEnabled=true, camEnabled=true, videoCollapsed=false, toastTimer=null, lastResultKey="";
let audioContext=null,lastSoundSnapshot=null,soundEnabled=true,previousHandIds=new Set(),previousTableIds=new Set();
function unlockAudio(){
  const AudioCtx=window.AudioContext||window.webkitAudioContext;
  if(!audioContext&&AudioCtx)audioContext=new AudioCtx();
  if(audioContext?.state==="suspended")audioContext.resume().catch(()=>{});
}
function playSfx(kind){
  if(!soundEnabled||!audioContext||audioContext.state!=="running")return;
  const now=audioContext.currentTime;
  // Короткий шорох бумаги/картона с мягким щелчком вместо электронного сигнала.
  const duration=kind==="deal"?.19:kind==="take"?.34:.16;
  const length=Math.floor(audioContext.sampleRate*duration);
  const buffer=audioContext.createBuffer(1,length,audioContext.sampleRate);
  const data=buffer.getChannelData(0);
  for(let i=0;i<length;i++){
    const fade=1-i/length;
    data[i]=(Math.random()*2-1)*fade*(kind==="take"?.55:.34);
  }
  const noise=audioContext.createBufferSource(),filter=audioContext.createBiquadFilter(),noiseGain=audioContext.createGain();
  noise.buffer=buffer;filter.type="lowpass";filter.frequency.setValueAtTime(kind==="take"?1500:kind==="deal"?2400:3200,now);
  noiseGain.gain.setValueAtTime(.0001,now);
  noiseGain.gain.exponentialRampToValueAtTime(kind==="take"?.12:.075,now+.018);
  noiseGain.gain.exponentialRampToValueAtTime(.0001,now+duration);
  noise.connect(filter);filter.connect(noiseGain);noiseGain.connect(audioContext.destination);noise.start(now);noise.stop(now+duration);
  if(kind==="card"||kind==="beat"||kind==="take"){
    const thump=audioContext.createOscillator(),thumpGain=audioContext.createGain();
    thump.type="sine";thump.frequency.setValueAtTime(kind==="take"?115:kind==="beat"?175:145,now);
    thumpGain.gain.setValueAtTime(.0001,now);thumpGain.gain.exponentialRampToValueAtTime(kind==="take"?.055:.035,now+.008);
    thumpGain.gain.exponentialRampToValueAtTime(.0001,now+.085);
    thump.connect(thumpGain);thumpGain.connect(audioContext.destination);thump.start(now);thump.stop(now+.09);
  }
  if(kind==="win"){const notes=[523,659,784,1047];notes.forEach((freq,i)=>{const osc=audioContext.createOscillator(),gain=audioContext.createGain();osc.type="sine";osc.frequency.setValueAtTime(freq,now+i*.13);gain.gain.setValueAtTime(.0001,now+i*.13);gain.gain.exponentialRampToValueAtTime(.075,now+i*.13+.02);gain.gain.exponentialRampToValueAtTime(.0001,now+i*.13+.24);osc.connect(gain);gain.connect(audioContext.destination);osc.start(now+i*.13);osc.stop(now+i*.13+.25)});return;}

}
function detectGameSound(g,hand,otherCount){
  const snapshot={table:g.table.map(p=>cardId(p.attack)+":"+(p.defense?cardId(p.defense):"")).join("|"),hand:hand.length,other:otherCount,finished:g.finished,deck:host?g.deck.length:g.deckCount};
  if(lastSoundSnapshot){
    const old=lastSoundSnapshot;
    if(!old.finished&&snapshot.finished)playSfx("win");
    else if(snapshot.table!==old.table){
      const oldCards=old.table?old.table.split("|").length:0;
      const newCards=snapshot.table?snapshot.table.split("|").length:0;
      const oldDef=(old.table.match(/:/g)||[]).filter((_,i)=>old.table.split("|")[i]?.endsWith(":")===false).length;
      const newDef=(snapshot.table.match(/:/g)||[]).filter((_,i)=>snapshot.table.split("|")[i]?.endsWith(":")===false).length;
      if(newCards>oldCards||newDef>oldDef)playSfx("card");
      else if(!snapshot.table&&old.table)playSfx(snapshot.hand+snapshot.other>old.hand+old.other?"take":"beat");
    }else if(snapshot.hand>old.hand&&snapshot.deck<old.deck)playSfx("deal");
  }else if(hand.length)playSfx("deal");
  lastSoundSnapshot=snapshot;
}
const isRed = c => c.suit==="♥" || c.suit==="♦";
const cardId = c => c.rank+c.suit;
const buildDeck = () => SUITS.flatMap(s=>RANKS.map(r=>({rank:r,suit:s})));
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function say(msg){$("lobbyStatus").textContent=msg}
function toast(msg){const el=$("toast");el.textContent=msg;el.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove("show"),2600)}
function connection(ok,label){$("connectionDot").classList.toggle("online",ok);$("connectionText").textContent=label}
function showGame(){ $("lobby").classList.add("hidden");$("game").classList.remove("hidden");$("roomCodeSmall").textContent=roomId}
function cardMarkup(c,selectedCard=false,extra=""){const face={J:["face-j","⚔","ВАЛЕТ"],Q:["face-q","♛","ДАМА"],K:["face-k","♚","КОРОЛЬ"]}[c.rank];return `<div class="card ${isRed(c)?"red":""} ${selectedCard?"selected":""} ${face?face[0]:""} ${extra}" data-card="${cardId(c)}"><span class="corner">${c.rank}<br>${c.suit}</span>${face?`<span class="court-portrait"><span class="court-symbol">${face[1]}</span><small>${face[2]}</small><i>${c.suit}</i></span>`:`<span class="suit">${c.suit}</span>`}<span class="corner bottom">${c.rank}<br>${c.suit}</span></div>`}
function beats(attack,defense,trump){if(attack.suit===defense.suit)return RV[defense.rank]>RV[attack.rank];return defense.suit===trump&&attack.suit!==trump}
function smallestTrump(hand,trump){return hand.filter(c=>c.suit===trump).sort((a,b)=>RV[a.rank]-RV[b.rank])[0]||null}
function newGame(){
  previousHandIds=new Set();previousTableIds=new Set();
  const deck=shuffle(buildDeck());
  const hands=[[],[]];
  for(let n=0;n<6;n++){hands[0].push(deck.pop());hands[1].push(deck.pop())}
  // Индекс 0 — нижняя карта колоды: козырь остаётся под колодой и добирается последним.
  const trump=deck[0].suit;
  const t0=smallestTrump(hands[0],trump),t1=smallestTrump(hands[1],trump);
  let attacker=0;
  if(t0&&t1)attacker=RV[t1.rank]<RV[t0.rank]?1:0;
  else if(t1)attacker=1;
  return {deck,hands,trump,attacker,defender:1-attacker,turn:attacker,phase:"attack",table:[],roundLimit:Math.min(6,hands[1-attacker].length),finished:false,winner:null,loser:null,round:1};
}
function snapshotFor(player){
  const g=state, other=1-player;
  return {kind:"STATE",version:1,hand:g.hands[player].map(cardId),opponentCount:g.hands[other].length,deckCount:g.deck.length,trump:g.trump,table:g.table.map(p=>({attack:cardId(p.attack),defense:p.defense?cardId(p.defense):null})),attacker:g.attacker,defender:g.defender,turn:g.turn,phase:g.phase,finished:g.finished,winner:g.winner,loser:g.loser,round:g.round};
}
function sendState(){if(!host)return;if(conn&&conn.open)conn.send(snapshotFor(1));render()}
function sendToGuest(obj){if(conn&&conn.open)conn.send(obj)}
function parseCard(id){return {rank:id.slice(0,-1),suit:id.slice(-1)}}
function decodeState(msg){
  showGame();
  const ids=[...msg.hand,...msg.table.flatMap(p=>[p.attack,p.defense].filter(Boolean))];
  const lookup=new Map(ids.map(id=>[id,parseCard(id)]));
  myHand=msg.hand.map(id=>lookup.get(id));
  state={deckCount:msg.deckCount,opponentCount:msg.opponentCount,trump:msg.trump,table:msg.table.map(p=>({attack:lookup.get(p.attack),defense:p.defense?lookup.get(p.defense):null})),attacker:msg.attacker,defender:msg.defender,turn:msg.turn,phase:msg.phase,finished:msg.finished,winner:msg.winner,loser:msg.loser,round:msg.round};
  seat=1;if(!state.finished){lastResultKey="";hideResult()}render();
}
function sendAction(action,data={}){if(host){applyAction(0,action,data);return}if(conn&&conn.open){conn.send({kind:"ACTION",action,data});return}toast("Нет соединения с создателем комнаты. Переподключись.")}
function validAttack(player,c){
  const g=state;
  // Атакующий вправе подкидывать карты и во время защиты.
  if(player!==g.attacker||g.finished)return false;
  if(g.phase!=="attack"&&g.phase!=="defend"&&g.phase!=="take")return false;
  if(g.table.length===0)return g.phase==="attack"&&g.turn===player;
  if(g.table.length>=Math.min(6,g.roundLimit))return false;
  const ranks=new Set(g.table.flatMap(p=>[p.attack.rank,p.defense?.rank].filter(Boolean)));
  return ranks.has(c.rank);
}
function applyAction(player,action,data){
  if(!host||!state)return;
  // Повторная партия разрешена только после завершения текущей.
  if(action==="REMATCH"){
    if(!state.finished)return;
    state=newGame();lastResultKey="";hideResult();publish();return;
  }
  if(state.finished)return;
  const g=state,hand=g.hands[player];
  if(action==="PLAY"){
    const index=hand.findIndex(c=>cardId(c)===data.id);if(index<0)return;
    const c=hand[index];
    if(player===g.attacker&&validAttack(player,c)&&(g.phase!=="take"||g.turn===player)){
      hand.splice(index,1);g.table.push({attack:c,defense:null});
      if(g.phase==="attack"){g.turn=g.defender;g.phase="defend";}
    }else if(player===g.defender&&g.phase==="defend"&&g.turn===player){
      const pair=g.table.find(p=>!p.defense&&beats(p.attack,c,g.trump));if(!pair)return;
      hand.splice(index,1);pair.defense=c;
      if(g.table.every(p=>p.defense)){g.turn=g.attacker;g.phase="attack"}
    }else return;
    publish();
  }else if(action==="TAKE"){
    if(player!==g.defender||g.turn!==player||g.phase!=="defend")return;
    g.phase="take";g.turn=g.attacker;publish();
  }else if(action==="FINISH_THROW"){
    if(player!==g.attacker||g.turn!==player||g.phase!=="take")return;
    const defenderHand=g.hands[g.defender];
    for(const p of g.table){defenderHand.push(p.attack);if(p.defense)defenderHand.push(p.defense)}
    g.table=[];g.turn=g.attacker;g.phase="attack";finishRound();
  }else if(action==="BEAT"){
    if(player!==g.attacker||g.turn!==player||g.phase!=="attack"||!g.table.length||g.table.some(p=>!p.defense))return;
    const oldAttacker=g.attacker;
    g.table=[];g.attacker=g.defender;g.defender=oldAttacker;g.turn=g.attacker;g.phase="attack";finishRound();
  }
}
function finishRound(){
  const g=state;
  // Draw order is the attacker first, then the defender.
  for(const player of [g.attacker,g.defender]){
    while(g.hands[player].length<6&&g.deck.length)g.hands[player].push(g.deck.pop());
  }
  g.round++;
  g.roundLimit=Math.min(6,g.hands[g.defender].length);
  checkWinner();
  publish();
}
function checkWinner(){
  const g=state;if(g.deck.length!==0)return;
  const empty=g.hands.map(h=>h.length===0);
  if(empty[0]&&empty[1]){g.finished=true;g.winner=null;g.loser=null}
  else if(empty[0]){g.finished=true;g.winner=0;g.loser=1}
  else if(empty[1]){g.finished=true;g.winner=1;g.loser=0}
}
function publish(){if(host)sendState();else render()}
function render(){
  if(!state)return;
  const g=state, hand=host?g.hands[0]:myHand, otherCount=host?g.hands[1].length:g.opponentCount, mySeat=host?0:1;
  detectGameSound(g,hand,otherCount);
  $("deckCount").textContent=host?g.deck.length:g.deckCount;
  $("opponentCount").textContent=`${otherCount} карт`;$("opponentCards").textContent=`${otherCount} карт`;
  $("myCount").textContent=`${hand.length} карт`;
  $("opponentHand").innerHTML=Array.from({length:Math.min(otherCount,14)},()=>'<span class="back-mini"></span>').join("");
  $("trumpCard").textContent=g.trump||"—";
  $("trumpCard").style.color=["♥","♦"].includes(g.trump)?"#c52e37":"#18202a";
  const currentTableIds=new Set(g.table.flatMap(p=>[cardId(p.attack),...(p.defense?[cardId(p.defense)]:[])]));
  $("battlefield").innerHTML=g.table.length?g.table.map(p=>`<div class="battle-pair">${cardMarkup(p.attack)}${p.defense?cardMarkup(p.defense,false,"defense"):""}</div>`).join(""):'<div class="empty-table">Карточный стол</div>';
  $("battlefield").querySelectorAll(".card").forEach(el=>{
    if(!previousTableIds.has(el.dataset.card)) el.animate([{opacity:0,translate:"0px -28px",scale:.94},{opacity:1,translate:"0px 4px",scale:1.02,offset:.72},{opacity:1,translate:"0px 0px",scale:1}],{duration:420,easing:"cubic-bezier(.18,.75,.25,1)",fill:"both"});
  });
  previousTableIds=currentTableIds;
  const currentHandIds=new Set(hand.map(cardId));
  $("myHand").innerHTML=hand.map(c=>cardMarkup(c,selected===cardId(c),previousHandIds.has(cardId(c))?"":"dealing")).join("");
  previousHandIds=currentHandIds;
  const handCards=$("myHand").querySelectorAll(".card");
  handCards.forEach((el,i)=>{
    const count=handCards.length,angle=count>1?(i-(count-1)/2)*Math.min(13,65/(count-1)):0;
    const lift=Math.abs(angle)*.45;
    el.style.setProperty("--fan-angle",angle+"deg");
    el.style.setProperty("--fan-lift",lift+"px");
    if(el.classList.contains("dealing")) el.animate([{opacity:0,translate:"0px -72px"},{opacity:1,translate:"0px 7px",offset:.72},{opacity:1,translate:"0px 0px"}],{duration:620,easing:"cubic-bezier(.2,.8,.2,1)",fill:"both",delay:i*65});
    el.addEventListener("click",()=>onCardTap(el.dataset.card));
  });
  const myTurn=g.turn===mySeat;
  let msg="Ход соперника";
  if(g.finished)msg="Партия завершена";
  else if(g.phase==="take"&&g.attacker===mySeat)msg="Соперник берёт карты. Можете подкинуть карты того же достоинства, затем завершите подкидывание.";
  else if(g.attacker===mySeat&&(g.phase==="attack"||g.phase==="defend"))msg=g.table.length?"Вы можете подкинуть карту того же достоинства.":"Ваш ход: выберите карту для атаки.";
  else if(myTurn)msg="Ваш ход: отбейтесь или возьмите карты.";
  else msg=g.phase==="attack"?"Соперник выбирает атаку…":"Соперник отбивается…";
  $("turnMessage").textContent=msg;$("gameHint").textContent=msg;
  $("takeBtn").textContent=g.phase==="take"?"✓ Завершить подкидывание":"↙ Беру";
  $("takeBtn").disabled=g.phase==="take"?!(myTurn&&g.attacker===mySeat):!(myTurn&&g.phase==="defend"&&g.defender===mySeat);
  $("beatBtn").disabled=!(myTurn&&g.phase==="attack"&&g.attacker===mySeat&&g.table.length>0&&g.table.every(p=>p.defense));
  $("rematchBtn").classList.toggle("hidden",!g.finished);
  if(!g.finished)hideResult();
  if(g.finished){
    const key=`${g.winner}-${g.loser}-${g.round}`;
    if(lastResultKey!==key){lastResultKey=key;const type=g.winner===null?"draw":g.winner===mySeat?"win":"loss";const title=type==="win"?"Победа!":type==="loss"?"Поражение":"Ничья";const body=type==="win"?"Отличная игра! Вы избавились от всех карт первым.":type==="loss"?"Партия завершена. В следующий раз удача может быть на вашей стороне!":"Оба игрока закончили карты одновременно.";showResult(title,body,type)}
  }
}
function onCardTap(id){
  if(!state||state.finished)return;
  const mySeat=host?0:1;
  const canAttack=state.attacker===mySeat&&(state.phase==="attack"||state.phase==="defend"||state.phase==="take");
  if(state.turn!==mySeat&&!canAttack){toast("Сейчас ход соперника");return}
  const hand=host?state.hands[0]:myHand;
  if(!hand.some(c=>cardId(c)===id))return;
  sendAction("PLAY",{id});selected=null;
}
function showResult(title,body,type="draw"){$("modalTitle").textContent=title;$("modalText").textContent=body;const card=$("modal").querySelector(".modal-card");card.classList.remove("result-win","result-loss","result-draw");card.classList.add("result-"+type);$("modalIcon").textContent=type==="win"?"🏆":type==="loss"?"♠":"🤝";$("modalStatus").textContent=type==="win"?"Вы выиграли партию":type==="loss"?"Победитель — соперник":"Партия завершилась вничью";$("modal").classList.remove("hidden")}
function hideResult(){$("modal").classList.add("hidden")}
async function requestMedia(){
  if(!navigator.mediaDevices?.getUserMedia){toast("Камера недоступна. Открой сайт по HTTPS в современном браузере.");return}
  try{
    localStream=await navigator.mediaDevices.getUserMedia({audio:true,video:{facingMode:"user",width:{ideal:640},height:{ideal:480}}});
    $("localVideo").srcObject=localStream;$("localPlaceholder").classList.add("hidden");
    $("micBtn").disabled=false;$("camBtn").disabled=false;
    if(mediaCall){mediaCall.close();mediaCall=null}
    if(!host&&peer)startOutgoingCall();
    return true;
  }catch(e){toast("Камера/микрофон не включены. Играть можно без них.");return false}
}
function showRemote(stream){remoteStream=stream;$("remoteVideo").srcObject=stream;$("remotePlaceholder").classList.add("hidden")}
function startOutgoingCall(){
  if(!peer||!localStream||host||!roomId)return;
  if(mediaCall){mediaCall.close();mediaCall=null}
  mediaCall=peer.call(roomId,localStream);
  if(mediaCall){mediaCall.on("stream",showRemote);mediaCall.on("close",()=>{$("remoteVideo").srcObject=null;$("remotePlaceholder").classList.remove("hidden")})}
}
function setupIncomingCalls(){
  if(!peer)return;
  peer.on("call",incoming=>{
    if(!localStream){incoming.answer();mediaCall=incoming;incoming.on("stream",showRemote);return}
    mediaCall=incoming;incoming.answer(localStream);incoming.on("stream",showRemote);
    incoming.on("close",()=>{$("remoteVideo").srcObject=null;$("remotePlaceholder").classList.remove("hidden")});
  });
}
function closeConnections(){
  if(mediaCall){mediaCall.close();mediaCall=null}
  if(conn){conn.close();conn=null}
  if(peer){peer.destroy();peer=null}
  if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null}
  remoteStream=null;$("localVideo").srcObject=null;$("remoteVideo").srcObject=null;
  $("localPlaceholder").classList.remove("hidden");$("remotePlaceholder").classList.remove("hidden");
  $("micBtn").disabled=true;$("camBtn").disabled=true;
  connection(false,"Не подключено");
}
function returnLobby(){
  closeConnections();state=null;myHand=[];selected=null;host=false;roomId="";lastResultKey="";
  $("game").classList.add("hidden");$("lobby").classList.remove("hidden");$("hostRoomInfo").classList.add("hidden");
  say("Создай комнату или подключись к другу.");
}
function handleHostConnection(c){
  if(conn&&conn.open){c.close();return}
  conn=c;
  c.on("open",()=>{connected=true;connection(true,"Игрок подключён");$("opponentName").textContent="Друг подключён";$("opponentLabel").textContent="Друг";state=newGame();sendState()});
  c.on("data",msg=>{if(!msg||msg.kind!=="ACTION")return;applyAction(1,msg.action,msg.data||{})});
  c.on("close",()=>{connected=false;connection(false,"Соперник отключился");toast("Соперник отключился. Комната остаётся открытой.")});
  c.on("error",e=>toast("Ошибка соединения: "+e.message));
}
function createRoom(){
  if(typeof window.Peer!=="function"){say("Не загрузилась библиотека подключения. Обнови страницу или проверь интернет.");toast("PeerJS не загрузился");return}
  closeConnections();host=true;seat=0;roomId=String(Math.floor(1000+Math.random()*9000));
  say("Создаём комнату…");peer=new Peer(roomId,{debug:1});
  peer.on("open",id=>{roomId=id;$("hostRoomCode").textContent=String(id).replace(/\D/g,"").slice(0,4);$("hostRoomInfo").classList.remove("hidden");say("Комната готова. Отправь код другу и дождись подключения.");connection(true,"Комната создана");showGame();$("opponentName").textContent="Ожидание игрока";$("opponentLabel").textContent="Соперник";});
  peer.on("connection",handleHostConnection);
  peer.on("call",incoming=>{
    if(!localStream){incoming.answer();mediaCall=incoming;incoming.on("stream",showRemote);return}
    mediaCall=incoming;incoming.answer(localStream);incoming.on("stream",showRemote);
  });
  peer.on("error",e=>{
    const detail=e?.type||e?.message||"неизвестная ошибка";
    say("Не удалось создать комнату: "+detail+". Нажми «Создать игру» ещё раз.");
    toast("Ошибка подключения: "+detail);
  });
  showGame();
  requestMedia();
}
function joinRoom(code){
  if(typeof window.Peer!=="function"){say("Не загрузилась библиотека подключения. Обнови страницу или проверь интернет.");toast("PeerJS не загрузился");return}
  closeConnections();host=false;seat=1;roomId=String(code).replace(/\D/g,"").slice(0,4);
  if(!/^\d{4}$/.test(roomId)){toast("Введи 4 цифры кода комнаты");return}
  const joinButton=$("joinRoom");
  joinButton.disabled=true;
  say("Подключаемся к серверу…");
  let settled=false,peerTimer=null,connTimer=null;
  const failJoin=message=>{
    if(settled)return;
    settled=true;clearTimeout(peerTimer);clearTimeout(connTimer);
    closeConnections();joinButton.disabled=false;
    say(message);toast(message);
  };
  peer=new Peer(undefined,{debug:1});
  peerTimer=setTimeout(()=>failJoin("Сервер не ответил. Проверь интернет и попробуй ещё раз."),15000);
  peer.on("open",()=>{
    clearTimeout(peerTimer);
    say("Сервер доступен. Подключаемся к комнате…");
    conn=peer.connect(roomId,{reliable:true});
    connTimer=setTimeout(()=>failJoin("Не удалось подключиться к комнате. Проверь код и попробуй снова."),15000);
    conn.on("open",()=>{
      clearTimeout(connTimer);settled=true;
      connection(true,"Подключено");
      $("opponentName").textContent="Хост";$("opponentLabel").textContent="Хост";
      say("Связь установлена. Загружаем игру…");
      joinButton.disabled=false;
    });
    conn.on("data",msg=>{if(msg?.kind==="STATE"){decodeState(msg);say("Игра синхронизирована.")}});
    conn.on("close",()=>{
      if(!settled){failJoin("Комната закрыта или соединение отклонено.");return}
      connection(false,"Соединение потеряно");toast("Связь с хостом потеряна. Вернись в лобби и подключись снова.");
    });
    conn.on("error",e=>failJoin("Ошибка подключения: "+(e?.message||"попробуй ещё раз")));
  });
  peer.on("call",incoming=>{
    if(!localStream){incoming.answer();mediaCall=incoming;incoming.on("stream",showRemote);return}
    mediaCall=incoming;incoming.answer(localStream);incoming.on("stream",showRemote);
  });
  peer.on("error",e=>failJoin("Ошибка сервера: "+(e?.type||e?.message||"не удалось подключиться")));
  requestMedia();
}
document.addEventListener("pointerdown",unlockAudio,{once:true});
$("createRoom").addEventListener("click",createRoom);
$("joinRoom").addEventListener("click",()=>joinRoom($("roomInput").value));
$("roomInput").addEventListener("input",e=>{e.target.value=e.target.value.replace(/\D/g,"").slice(0,6)});
$("roomInput").addEventListener("keydown",e=>{if(e.key==="Enter")joinRoom($("roomInput").value)});
$("copyInvite").addEventListener("click",async()=>{
  const invite=`Подкидной дурак онлайн. Код комнаты: ${roomId}`;
  try{await navigator.clipboard.writeText(invite);toast("Приглашение скопировано")}
  catch{toast("Код комнаты: "+roomId)}
});
$("takeBtn").addEventListener("click",()=>sendAction(state?.phase==="take"?"FINISH_THROW":"TAKE"));
$("beatBtn").addEventListener("click",()=>sendAction("BEAT"));
$("leaveGame").addEventListener("click",returnLobby);
$("rematchBtn").addEventListener("click",()=>sendAction("REMATCH"));
$("modalRematch").addEventListener("click",()=>sendAction("REMATCH"));
$("modalClose").addEventListener("click",hideResult);
$("modalLobby").addEventListener("click",returnLobby);
$("micBtn").addEventListener("click",()=>{
  if(!localStream)return;micEnabled=!micEnabled;localStream.getAudioTracks().forEach(t=>t.enabled=micEnabled);
  $("micBtn").classList.toggle("off",!micEnabled);$("micBtn").querySelector("span").textContent=micEnabled?"Микрофон":"Микрофон выкл.";
});
$("camBtn").addEventListener("click",()=>{
  if(!localStream)return;camEnabled=!camEnabled;localStream.getVideoTracks().forEach(t=>t.enabled=camEnabled);
  $("camBtn").classList.toggle("off",!camEnabled);$("camBtn").querySelector("span").textContent=camEnabled?"Камера":"Камера выкл.";
});
$("soundToggle").addEventListener("click",()=>{
  soundEnabled=!soundEnabled;
  $("soundToggle").classList.toggle("off",!soundEnabled);
  $("soundToggle").querySelector("span").textContent=soundEnabled?"Звук Вкл.":"Звук Выкл.";
  if(soundEnabled){unlockAudio();playSfx("card")}
});
$("videoToggle").addEventListener("click",()=>{
  videoCollapsed=!videoCollapsed;$("videoDock").classList.toggle("collapsed",videoCollapsed);
  $("videoToggle").querySelector("span").textContent=videoCollapsed?"Показать видео":"Свернуть видео";
});
(()=>{
  const box=$("videoDock").querySelector(".self-box");
  const table=document.querySelector(".table");
  if(!box||!table)return;
  let dragging=false,offsetX=0,offsetY=0;
  const point=e=>e.touches?e.touches[0]:e;
  const begin=e=>{
    if(e.type==="mousedown"&&e.button!==0)return;
    const p=point(e),br=box.getBoundingClientRect(),tr=table.getBoundingClientRect();
    if(box.style.left===""){
      box.style.left=(br.left-tr.left)+"px";
      box.style.top=(br.top-tr.top)+"px";
      box.style.right="auto";
    }
    dragging=true;offsetX=p.clientX-br.left;offsetY=p.clientY-br.top;
    box.classList.add("dragging");
    if(e.cancelable)e.preventDefault();
  };
  const move=e=>{
    if(!dragging)return;
    const p=point(e),tr=table.getBoundingClientRect(),br=box.getBoundingClientRect();
    const left=Math.min(Math.max(0,tr.width-br.width),Math.max(0,p.clientX-tr.left-offsetX));
    const top=Math.min(Math.max(0,tr.height-br.height),Math.max(0,p.clientY-tr.top-offsetY));
    box.style.left=left+"px";box.style.top=top+"px";
    if(e.cancelable)e.preventDefault();
  };
  const stop=()=>{dragging=false;box.classList.remove("dragging")};
  box.addEventListener("pointerdown",begin);
  document.addEventListener("pointermove",move,{passive:false});
  document.addEventListener("pointerup",stop);
  document.addEventListener("pointercancel",stop);
  box.addEventListener("mousedown",begin);
  document.addEventListener("mousemove",move);
  document.addEventListener("mouseup",stop);
  box.addEventListener("touchstart",begin,{passive:false});
  document.addEventListener("touchmove",move,{passive:false});
  document.addEventListener("touchend",stop);
})();
window.addEventListener("beforeunload",closeConnections);
})();

/* Decorative kitten idle actions: visual only, independent of game state */
(function(){
  const cat=document.querySelector(".kitten-walk");
  if(!cat)return;
  const action=document.querySelector(".kitten-action");
  const moods=[
    {name:"grooming",symbol:"✨",duration:4200},
    {name:"sleeping",symbol:"💤",duration:5600},
    {name:"playing",symbol:"",duration:4300},
    {name:"sitting",symbol:"🐾",duration:3500}
  ];
  let timer=null,clearTimer=null,last=-1;
  function choose(){
    if(document.hidden){timer=setTimeout(choose,5000);return;}
    let n=Math.floor(Math.random()*moods.length);
    if(n===last)n=(n+1)%moods.length;
    last=n;
    const mood=moods[n];
    cat.classList.remove("grooming","sleeping","playing","sitting");
    cat.classList.add(mood.name);
    action.textContent=mood.symbol;
    clearTimeout(clearTimer);
    clearTimer=setTimeout(()=>{
      cat.classList.remove(mood.name);
      action.textContent="";
    },mood.duration);
    timer=setTimeout(choose,9000+Math.random()*7000);
  }
  timer=setTimeout(choose,7000);
  document.addEventListener("visibilitychange",()=>{
    if(!document.hidden&&!timer)timer=setTimeout(choose,2500);
  });
})();
