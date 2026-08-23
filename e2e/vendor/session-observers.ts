import type { SignalingSession } from '@open4wd/interfaces';

type MessageHandler = Parameters<SignalingSession['onMessage']>[0];
type PeerJoinedHandler = Parameters<NonNullable<SignalingSession['onPeerJoined']>>[0];
type PeerLeftHandler = Parameters<NonNullable<SignalingSession['onPeerLeft']>>[0];
type CloseHandler = Parameters<NonNullable<SignalingSession['onClose']>>[0];

/** signaling session transport adapter 共用的 handler 集合。 */
export interface SignalingSessionObserverSets {
  messages: Set<MessageHandler>;
  joined: Set<PeerJoinedHandler>;
  left: Set<PeerLeftHandler>;
  close: Set<CloseHandler>;
}

/** 為 signaling session 建立共用 subscribe／unsubscribe surface。 */
export function createSignalingSessionObservers(
  sets: SignalingSessionObserverSets,
  notifyCloseImmediately: () => boolean,
): Pick<SignalingSession, 'onMessage' | 'onPeerJoined' | 'onPeerLeft' | 'onClose'> {
  return {
    onMessage: (handler) => {
      sets.messages.add(handler);
      return () => sets.messages.delete(handler);
    },
    onPeerJoined: (handler) => {
      sets.joined.add(handler);
      return () => sets.joined.delete(handler);
    },
    onPeerLeft: (handler) => {
      sets.left.add(handler);
      return () => sets.left.delete(handler);
    },
    onClose: (handler) => {
      sets.close.add(handler);
      if (notifyCloseImmediately()) handler();
      return () => sets.close.delete(handler);
    },
  };
}
