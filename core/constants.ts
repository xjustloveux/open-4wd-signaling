/** 服務層常數。上限類數值須與客戶端解析器一致，逾越會使訊息被客戶端整則丟棄。 */

import { Protocol } from './protocol';

/** 逾此時間未見存活回報即回收該 peer；容許連丟兩次 pong */
export const PEER_TIMEOUT_MS = 90_000;
/** 連線須在此窗內完成 register，否則關閉 */
export const REGISTER_DEADLINE_MS = 10_000;
/** 房間人數上限；客戶端解析器對超過此數的成員快照會整則丟棄 */
export const MAX_PEERS = 64;
/** register 證明的時戳容忍窗（毫秒）；由協定層常數推導，與客戶端恆等 */
export const TIMESTAMP_TOLERANCE_MS = Protocol.security.P2P_MESSAGE_TIMESTAMP_TOLERANCE_SEC * 1_000;

/** 單一來源在固定窗內允許建立的連線數。 */
export const RATE_LIMIT_PER_MIN = 60;
/** 連線限流固定窗的毫秒數。 */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** 已註冊連線的訊息級限流（每連線每分鐘）。轉發為 1:1 無放大，此限只為擋線速灌流；64 人房開賽的 full-mesh 握手突發約 750 則，故取寬裕值。逾額靜默丟棄不斷線。 */
export const MESSAGE_RATE_LIMIT_PER_MIN = 1_200;

/** 伺服器自身送出訊息時的 sender 值 */
export const SERVER_SENDER = 'server';

/** 註冊證明或註冊訊息不合法時使用的錯誤碼。 */
export const ERR_REGISTER_REJECTED = 'register-rejected';
/** 房間已達成員上限時使用的錯誤碼。 */
export const ERR_ROOM_FULL = 'room-full';
/** 訊號目標不在房間內時使用的錯誤碼。 */
export const ERR_TARGET_NOT_FOUND = 'target-not-found';
/** 房間已停止接受操作時使用的錯誤碼。 */
export const ERR_ROOM_CLOSED = 'room-closed';
/** 連線尚未註冊即送出其他訊息時使用的錯誤碼。 */
export const ERR_NOT_REGISTERED = 'not-registered';
/** 訊息宣告身分與已註冊身分不符時使用的錯誤碼。 */
export const ERR_SENDER_MISMATCH = 'sender-mismatch';
/** 連線未在期限內完成註冊時使用的錯誤碼。 */
export const ERR_REGISTER_TIMEOUT = 'register-timeout';
/** 同一節點以新連線取代舊連線時使用的錯誤碼。 */
export const ERR_SUPERSEDED = 'superseded';
/** 節點超過存活回報期限時使用的錯誤碼。 */
export const ERR_PEER_TIMEOUT = 'peer-timeout';
/** 連線自行送出 leave 後，伺服器主動關閉該連線時使用的代碼 */
export const ERR_LEFT = 'left';

/** /turn-token 驗身的 purpose 哨兵——佔用 register proof 的 room 位做域分隔。
 * 房名來自 ?room= query、值可含 '/'——不相撞非結構保證：伺服器升級處以 guard
 * 拒絕「等於本值或以 '/' 開頭」的房名註冊，'/' 前綴命名空間整段保留給內部用途。 */
export const TURN_TOKEN_PURPOSE = '/turn-token';
/** TURN REST 憑證壽命（秒）；coturn 端以 username 內嵌的到期時戳自行判過期。
 * 與 core/protocol/shim/system-constants.ts 的 Network.signaling.TURN_TOKEN_TTL_SEC 同值同步。 */
export const TURN_TOKEN_TTL_SEC = 300;
