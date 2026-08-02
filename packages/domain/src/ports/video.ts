/**
 * §19 — managed video. We do not build WebRTC.
 * Screen sharing is non-negotiable: it is how Salesforce debugging actually happens.
 */
export interface VideoRoom {
  readonly provider: string;
  readonly roomId: string;
  readonly roomUrl: string;
  readonly expiresAt: Date;
}

export interface VideoRoomToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface VideoProvider {
  readonly name: string;
  createRoom(params: {
    readonly sessionId: string;
    readonly expiresAt: Date;
    readonly enableScreenShare: boolean;
    /** V1 never records. Sessions may expose production orgs and customer data (§Q8). */
    readonly enableRecording: false;
  }): Promise<VideoRoom>;
  issueToken(roomId: string, userId: string, isOwner: boolean): Promise<VideoRoomToken>;
  deleteRoom(roomId: string): Promise<void>;
}
