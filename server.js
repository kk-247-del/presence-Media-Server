// ignore_for_file: avoid_print

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../knock/presence_lock_guard.dart';
import '../models/presence_address.dart';
import 'media_engine.dart';

/* ───────────────── LOGGING ───────────────── */

void momentLog(String msg) {
  final line = '[PRESENCE][ENGINE] $msg';
  kIsWeb ? print(line) : debugPrint(line);
}

/* ───────────────── STATE ───────────────── */

enum MomentReadiness { idle, waiting, alive }

class MomentEngineState {
  final MomentReadiness readiness;
  final String? collapseReason;
  const MomentEngineState(this.readiness, [this.collapseReason]);
}

/* ───────────────── PROVIDERS ───────────────── */

final momentEngineProvider = StateNotifierProvider<MomentEngine, MomentEngineState>(
  (ref) => MomentEngine(ref),
);

// Provider for the Registry UI to listen to
final dashboardProvider = StateProvider<List<PresenceAddress>>((ref) => []);

final peerObstructionProvider = StateProvider<dynamic>((_) => null);

/* ───────────────── ENGINE ───────────────── */

class MomentEngine extends StateNotifier<MomentEngineState> with WidgetsBindingObserver {
  final Ref ref;

  MomentEngine(this.ref) : super(const MomentEngineState(MomentReadiness.idle)) {
    WidgetsBinding.instance.addObserver(this);
    Future.microtask(_bindMediaBridge);
  }

  /* ───────────────── CALLBACKS ───────────────── */

  void Function(String)? onRemoteText;
  void Function(bool)? onRemoteHold;
  void Function()? onRemoteClear;
  void Function(Uint8List, int, int)? onRevealFrame;
  void Function(int)? onPeerObstructed;
  void Function()? onPeerRestored;

  /* ───────────────── INTERNAL ───────────────── */

  WebSocketChannel? _ws;
  Timer? _heartbeat;
  bool _collapsing = false;
  bool _attentionExempted = false;

  bool get attentionExempted => _attentionExempted;

  /* ───────────────── MEDIA BRIDGE ───────────────── */

  void _bindMediaBridge() {
    ref.read(mediaSignalBridgeProvider.notifier).state = sendSignal;
  }

  /* ───────────────── REGISTRY & CONNECTION ───────────────── */

  /// Call this when entering the PresenceSurface to ensure the socket is open
  void initializeRegistry() {
    if (_ws == null) {
      momentLog("Initializing Registry Connection...");
      _connectAndJoin({}); 
    }
  }

  Future<void> _connectAndJoin(Map<String, dynamic> payload) async {
    try {
      _ws = WebSocketChannel.connect(
        Uri.parse('wss://presence-media-server-production.up.railway.app/ws'),
      );

      _ws!.stream.listen(
        _onMessage,
        onDone: () => _collapseHard('socket_closed'),
        onError: (e) => _collapseHard('socket_error'),
        cancelOnError: true,
      );

      // If we have a payload (like an address to join), send it immediately
      if (payload.isNotEmpty) {
        sendSignal({'type': 'join', ...payload});
      }

      _heartbeat?.cancel();
      _heartbeat = Timer.periodic(const Duration(seconds: 15), (_) {
        sendSignal({'type': 'ping'});
      });
    } catch (e) {
      momentLog("Connection error: $e");
    }
  }

  /* ───────────────── PUBLIC API ───────────────── */

  void reservePresence({required String nickname, required int hours, required bool keepAlive}) {
    momentLog("Requesting Reservation for $nickname");
    sendSignal({
      'type': 'reserve_address',
      'nickname': nickname,
      'expiryHours': hours,
      'keepAliveOnFailure': keepAlive,
    });
  }

  void deletePresence(String id) {
    momentLog("Deleting address: $id");
    sendSignal({'type': 'delete_address', 'addressId': id});
  }

  Future<void> declarePresence(String address) async {
    if (ref.read(presenceLockProvider)) return;
    _reset();
    state = const MomentEngineState(MomentReadiness.waiting);
    await _connectAndJoin({'address': address});
  }

  void sendSignal(Map<String, dynamic> payload) {
    if (_ws == null) {
      momentLog("Cannot send signal: Socket is NULL. Reconnecting...");
      _connectAndJoin({});
      return;
    }
    _ws?.sink.add(jsonEncode(payload));
  }

  /* ───────────────── MESSAGE HANDLING ───────────────── */

  Future<void> _onMessage(dynamic raw) async {
    final msg = jsonDecode(raw as String) as Map<String, dynamic>;
    momentLog("Inbound: ${msg['type']}");

    switch (msg['type']) {
      case 'dashboard_update':
        final List rawList = msg['addresses'] ?? [];
        ref.read(dashboardProvider.notifier).state = 
            rawList.map((j) => PresenceAddress.fromJson(j)).toList();
        break;

      case 'ready':
        ref.read(presenceLockProvider.notifier).state = true;
        final initiator = msg['role'] == 'initiator';
        ref.read(mediaEngineProvider.notifier).setPolite(!initiator);
        await ref.read(mediaEngineProvider.notifier).warmUpMedia();
        if (initiator) {
          await ref.read(mediaEngineProvider.notifier).maybeMakeOffer();
        }
        state = const MomentEngineState(MomentReadiness.alive);
        break;

      case 'webrtc_offer':
        await ref.read(mediaEngineProvider.notifier).handleRemoteOffer(msg);
        break;

      case 'webrtc_answer':
        await ref.read(mediaEngineProvider.notifier).handleRemoteAnswer(msg);
        break;

      case 'webrtc_ice':
        await ref.read(mediaEngineProvider.notifier).addIceCandidate(msg);
        break;

      case 'text':
        onRemoteText?.call(msg['text'] ?? '');
        break;

      case 'reveal_frame':
        onRevealFrame?.call(base64Decode(msg['bytes']), msg['w'], msg['h']);
        break;

      case 'collapse':
        _collapseHard(msg['reason'] ?? 'remote_end');
        break;
    }
  }

  /* ───────────────── LIFECYCLE ───────────────── */

  void collapseImmediatelyByUser() => _collapseHard('user_terminated');

  void _collapseHard(String reason) {
    if (_collapsing) return;
    _collapsing = true;
    _heartbeat?.cancel();
    ref.read(mediaEngineProvider.notifier).disposeMedia();
    _ws?.sink.close();
    _ws = null;
    ref.read(presenceLockProvider.notifier).state = false;
    state = MomentEngineState(MomentReadiness.idle, reason);
  }

  void _reset() {
    _collapsing = false;
    _heartbeat?.cancel();
    _ws?.sink.close();
    _ws = null;
    ref.read(mediaEngineProvider.notifier).disposeMedia();
    ref.read(presenceLockProvider.notifier).state = false;
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _reset();
    super.dispose();
  }
}
