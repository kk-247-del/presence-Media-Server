import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

/* ───────────────── SIGNAL BRIDGE ───────────────── */

final mediaSignalBridgeProvider =
    StateProvider<void Function(Map<String, dynamic>)>(
  (_) => (_) {},
);

/* ───────────────── PROVIDER ───────────────── */

final mediaEngineProvider = StateNotifierProvider<MediaEngine, MediaState>(
  (ref) => MediaEngine(
    ref,
    sendSignal: (payload) =>
        ref.read(mediaSignalBridgeProvider)(payload),
  ),
);

/* ───────────────── STATE ───────────────── */

enum MediaConnectionState { idle, warming, connected, failed }

class MediaState {
  final bool audioLive;
  final bool videoLive;
  final bool ready;
  final MediaConnectionState connection;

  const MediaState({
    required this.audioLive,
    required this.videoLive,
    required this.ready,
    required this.connection,
  });

  static const idle = MediaState(
    audioLive: false,
    videoLive: false,
    ready: false,
    connection: MediaConnectionState.idle,
  );

  MediaState copyWith({
    bool? audioLive,
    bool? videoLive,
    bool? ready,
    MediaConnectionState? connection,
  }) {
    return MediaState(
      audioLive: audioLive ?? this.audioLive,
      videoLive: videoLive ?? this.videoLive,
      ready: ready ?? this.ready,
      connection: connection ?? this.connection,
    );
  }
}

/* ───────────────── ENGINE ───────────────── */

class MediaEngine extends StateNotifier<MediaState> {
  final Ref ref;
  final void Function(Map<String, dynamic>) _sendSignal;

  MediaEngine(
    this.ref, {
    required void Function(Map<String, dynamic>) sendSignal,
  })  : _sendSignal = sendSignal,
        super(MediaState.idle);

  RTCPeerConnection? _pc;
  MediaStream? _local;
  MediaStream? _remote;

  RTCRtpTransceiver? _audioTx;
  RTCRtpTransceiver? _videoTx;

  bool _makingOffer = false;
  bool _polite = false;

  MediaStream? get localStream => _local;
  MediaStream? get remoteStream => _remote;
  bool get isPolite => _polite;

  void setPolite(bool polite) {
    _polite = polite;
    _log(polite ? 'Polite peer' : 'Impolite peer');
  }

  void _log(String msg) {
    final line = '[MEDIA] $msg';
    if (kIsWeb) {
      // ignore: avoid_print
      print(line);
    } else {
      debugPrint(line);
    }
  }

  /* ───────────────── MEDIA WARM-UP ───────────────── */

  Future<void> warmUpMedia() async {
    if (state.ready) return;

    state = state.copyWith(connection: MediaConnectionState.warming);

    _local = await navigator.mediaDevices.getUserMedia({
      'audio': true,
      'video': {
        'facingMode': 'user',
        'width': 1280,
        'height': 720,
        'frameRate': 30,
      },
    });

    _pc = await createPeerConnection({
      'iceServers': [
        {'urls': 'stun:stun.l.google.com:19302'},
      ],
    });

    // Explicit transceivers (required on Web)
    _audioTx = await _pc!.addTransceiver(
      kind: RTCRtpMediaType.RTCRtpMediaTypeAudio,
      init: RTCRtpTransceiverInit(
        direction: TransceiverDirection.SendRecv,
      ),
    );

    _videoTx = await _pc!.addTransceiver(
      kind: RTCRtpMediaType.RTCRtpMediaTypeVideo,
      init: RTCRtpTransceiverInit(
        direction: TransceiverDirection.SendRecv,
      ),
    );

    _pc!.onTrack = (event) {
      _remote = event.streams.first;
      _log('Remote track attached');
    };

    _pc!.onIceCandidate = (c) {
      if (c.candidate == null) return;
      _sendSignal({
        'type': 'webrtc_ice',
        'candidate': c.candidate,
        'sdpMid': c.sdpMid,
        'sdpMLineIndex': c.sdpMLineIndex,
      });
    };

    _pc!.onConnectionState = (s) {
      _log('PC state → $s');
      if (s == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        state = state.copyWith(connection: MediaConnectionState.connected);
      }
      if (s == RTCPeerConnectionState.RTCPeerConnectionStateFailed) {
        state = state.copyWith(connection: MediaConnectionState.failed);
      }
    };

    state = state.copyWith(ready: true);
    _log('Pipelines warm');
  }

  /* ───────────────── NEGOTIATION ───────────────── */

  /// Initiator only. No signalingState guard here.
  Future<void> maybeMakeOffer() async {
    if (_pc == null || _makingOffer) return;

    try {
      _makingOffer = true;

      final offer = await _pc!.createOffer();
      await _pc!.setLocalDescription(offer);

      _sendSignal({
        'type': 'webrtc_offer',
        'sdp': offer.sdp,
        'sdpType': offer.type,
      });

      _log('Offer sent');
    } finally {
      _makingOffer = false;
    }
  }

  /// Perfect Negotiation: glare-safe
  Future<void> handleRemoteOffer(Map<String, dynamic> msg) async {
    if (_pc == null) return;

    final offer = RTCSessionDescription(
      msg['sdp'],
      msg['sdpType'],
    );

    final collision =
        _makingOffer ||
        _pc!.signalingState !=
            RTCSignalingState.RTCSignalingStateStable;

    if (!_polite && collision) {
      _log('Ignoring offer (glare)');
      return;
    }

    await _pc!.setRemoteDescription(offer);

    final answer = await _pc!.createAnswer();
    await _pc!.setLocalDescription(answer);

    _sendSignal({
      'type': 'webrtc_answer',
      'sdp': answer.sdp,
      'sdpType': answer.type,
    });

    _log('Answer sent');
  }

  Future<void> handleRemoteAnswer(Map<String, dynamic> msg) async {
    if (_pc == null) return;

    await _pc!.setRemoteDescription(
      RTCSessionDescription(
        msg['sdp'],
        msg['sdpType'],
      ),
    );

    _log('Answer applied');
  }

  Future<void> addIceCandidate(Map<String, dynamic> msg) async {
    if (_pc == null) return;

    await _pc!.addCandidate(
      RTCIceCandidate(
        msg['candidate'],
        msg['sdpMid'],
        msg['sdpMLineIndex'],
      ),
    );
  }

  /* ───────────────── ESCALATION ───────────────── */

  Future<void> escalateAudio() async {
    final track = _local!.getAudioTracks().first;
    await _audioTx!.sender.replaceTrack(track);
    state = state.copyWith(audioLive: true);
    _log('Audio escalated');
  }

  Future<void> escalateVideo() async {
    final track = _local!.getVideoTracks().first;
    await _videoTx!.sender.replaceTrack(track);
    state = state.copyWith(videoLive: true);
    _log('Video escalated');
  }

  /* ───────────────── TEARDOWN ───────────────── */

  Future<void> disposeMedia() async {
    _log('Dispose media');

    for (final t in _local?.getTracks() ?? []) {
      await t.stop();
    }
    await _pc?.close();

    _pc = null;
    _local = null;
    _remote = null;

    state = MediaState.idle;
  }
}
