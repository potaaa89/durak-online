(() => {
"use strict";
const $ = id => document.getElementById(id);
const SUITS = ["♠","♥","♦","♣"], RANKS = ["6","7","8","9","10","J","Q","K","A"];
const RV = Object.fromEntries(RANKS.map((r,i)=>[r,i]));
let peer=null, conn=null, mediaCall=null, localStream=null, remoteStream=null;
let host=false, roomId="", state=null, myHand=[], seat=0, selected=null, connected=false;
let micEnabled=true, camEnabled=true, videoCollapsed=false, toastTimer=null, lastResultKey="";
const isRed = c => c.suit==="♥" || c.suit==="♦";
const cardId = c => c.rank+c.suit;
const buildDeck = () => SUITS.flatMap(s=>RANKS.map(r=>({rank:r,suit:s})));
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function say(msg){$("lobbyStatus").textContent=msg}
function toast(msg){const el=$("toast");el.textContent=msg;el.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove("show"),2600)}
function connection(ok,label){$("connectionDot").classList.toggle("online",ok);$("connectionText").textContent=label}
function showGame(){ $("lobby").classList.add("hidden");$("game").classList.remove("hidden");$("roomCodeSmall").textContent=roomId}
function cardMarkup(c,selectedCard=false,extra=""){return `<div class="card ${isRed(c)?"red":""} ${selectedCard?"selected":""} ${extra}" data-card="${cardId(c)}"><span class="corner">${c.rank}<br>${c.suit}</span><span class="suit">${c.suit}</span><span class="corner bottom">${c.rank}<br>${c.suit}</span></div>`}
function beats(attack,defense,trump){if(attack.suit===defense.suit)return RV[defense.rank]>RV[attack.rank];return defense.suit===trump&&attack.suit!==trump}
function smallestTrump(hand,trump){return hand.filter(c=>c.suit===trump).sort((a,b)=>RV[a.rank]-RV[b.rank])[0]||null}
function newGame(){
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
  $("deckCount").textContent=host?g.deck.length:g.deckCount;
  $("opponentCount").textContent=`${otherCount} карт`;$("opponentCards").textContent=`${otherCount} карт`;
  $("myCount").textContent=`${hand.length} карт`;
  $("opponentHand").innerHTML=Array.from({length:Math.min(otherCount,14)},()=>'<span class="back-mini"></span>').join("");
  $("trumpCard").textContent=g.trump||"—";
  $("trumpCard").style.color=["♥","♦"].includes(g.trump)?"#c52e37":"#18202a";
  $("battlefield").innerHTML=g.table.length?g.table.map(p=>`<div class="battle-pair">${cardMarkup(p.attack)}${p.defense?cardMarkup(p.defense,false,"defense"):""}</div>`).join(""):'<div class="empty-table">Карточный стол</div>';
  $("myHand").innerHTML=hand.map(c=>cardMarkup(c,selected===cardId(c))).join("");
  $("myHand").querySelectorAll(".card").forEach(el=>el.addEventListener("click",()=>onCardTap(el.dataset.card)));
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
    if(lastResultKey!==key){lastResultKey=key;const title=g.winner===null?"Ничья":g.winner===mySeat?"Вы победили!":"Победил соперник";showResult(title,g.winner===null?"Оба игрока закончили карты одновременно.":g.winner===mySeat?"Поздравляем!":"В этот раз победил соперник.")}
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
function showResult(title,body){$("modalTitle").textContent=title;$("modalText").textContent=body;$("modal").classList.remove("hidden")}
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
  closeConnections();host=true;seat=0;roomId=String(Math.floor(100000+Math.random()*900000));
  say("Создаём комнату…");peer=new Peer(roomId,{debug:0});
  peer.on("open",id=>{roomId=id;$("hostRoomCode").textContent=id;$("hostRoomInfo").classList.remove("hidden");say("Комната готова. Отправь код другу и дождись подключения.");connection(true,"Комната создана");showGame();$("opponentName").textContent="Ожидание игрока";$("opponentLabel").textContent="Соперник";});
  peer.on("connection",handleHostConnection);
  peer.on("call",incoming=>{
    if(!localStream){incoming.answer();mediaCall=incoming;incoming.on("stream",showRemote);return}
    mediaCall=incoming;incoming.answer(localStream);incoming.on("stream",showRemote);
  });
  peer.on("error",e=>{say("Ошибка PeerJS: "+e.message);toast("PeerJS: "+e.type)});
  showGame();
  requestMedia();
}
function joinRoom(code){
  closeConnections();host=false;seat=1;roomId=String(code).replace(/\D/g,"").slice(0,6);
  if(!/^\d{6}$/.test(roomId)){toast("Введи 6 цифр кода комнаты");return}
  say("Подключаемся…");peer=new Peer(undefined,{debug:0});
  peer.on("open",()=>{
    conn=peer.connect(roomId,{reliable:true});
    conn.on("open",()=>{connection(true,"Подключено");$("opponentName").textContent="Хост";$("opponentLabel").textContent="Хост";say("Подключено к комнате.");});
    conn.on("data",msg=>{if(msg?.kind==="STATE"){decodeState(msg);say("Игра синхронизирована.")}});
    conn.on("close",()=>{connection(false,"Соединение потеряно");toast("Связь с хостом потеряна. Вернись в лобби и подключись снова.")});
    conn.on("error",e=>toast("Ошибка соединения: "+e.message));
  });
  peer.on("call",incoming=>{
    if(!localStream){incoming.answer();mediaCall=incoming;incoming.on("stream",showRemote);return}
    mediaCall=incoming;incoming.answer(localStream);incoming.on("stream",showRemote);
  });
  peer.on("error",e=>{say("Не удалось подключиться: "+e.message);toast("PeerJS: "+e.type)});
  showGame();
  requestMedia();
}
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
$("micBtn").addEventListener("click",()=>{
  if(!localStream)return;micEnabled=!micEnabled;localStream.getAudioTracks().forEach(t=>t.enabled=micEnabled);
  $("micBtn").classList.toggle("off",!micEnabled);$("micBtn").querySelector("span").textContent=micEnabled?"Микрофон":"Микрофон выкл.";
});
$("camBtn").addEventListener("click",()=>{
  if(!localStream)return;camEnabled=!camEnabled;localStream.getVideoTracks().forEach(t=>t.enabled=camEnabled);
  $("camBtn").classList.toggle("off",!camEnabled);$("camBtn").querySelector("span").textContent=camEnabled?"Камера":"Камера выкл.";
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