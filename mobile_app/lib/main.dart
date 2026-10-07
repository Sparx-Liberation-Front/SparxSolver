import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _ink = Color(0xFFE8EEF5);
const _mutedInk = Color(0xFFAAB7C5);
const _background = Color(0xFF10161D);
const _panel = Color(0xFF1B242D);
const _accent = Color(0xFF2F9E9A);
const _accentStrong = Color(0xFF237A78);

class MathMarkup extends StatelessWidget {
  const MathMarkup(this.value, {super.key, this.fontSize = 14, this.color = _ink});

  final String value;
  final double fontSize;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final parts = RegExp(r'(\$\$.*?\$\$|\$.*?\$|\\\(.*?\\\)|\\\[.*?\\\])', dotAll: true)
        .allMatches(value)
        .toList();
    if (parts.isEmpty) return Text(value, style: TextStyle(color: color, fontSize: fontSize, height: 1.35));

    final children = <Widget>[];
    var cursor = 0;
    for (final match in parts) {
      if (match.start > cursor) {
        children.add(Text(value.substring(cursor, match.start), style: TextStyle(color: color, fontSize: fontSize, height: 1.35)));
      }
      var expression = match.group(0)!;
      final display = expression.startsWith(r'$$') || expression.startsWith(r'\[');
      if (expression.startsWith(r'$$')) expression = expression.substring(2, expression.length - 2);
      if (expression.startsWith(r'$')) expression = expression.substring(1, expression.length - 1);
      if (expression.startsWith(r'\(')) expression = expression.substring(2, expression.length - 2);
      if (expression.startsWith(r'\[')) expression = expression.substring(2, expression.length - 2);
      children.add(Padding(
        padding: EdgeInsets.symmetric(vertical: display ? 4 : 0),
        child: Math.tex(
          expression,
          mathStyle: display ? MathStyle.display : MathStyle.text,
          textStyle: TextStyle(color: color, fontSize: fontSize),
          onErrorFallback: (error) => Text(expression, style: TextStyle(color: color, fontSize: fontSize)),
        ),
      ));
      cursor = match.end;
    }
    if (cursor < value.length) {
      children.add(Text(value.substring(cursor), style: TextStyle(color: color, fontSize: fontSize, height: 1.35)));
    }
    return Wrap(crossAxisAlignment: WrapCrossAlignment.center, children: children);
  }
}

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const SparxSolverApp());
}

class SparxSolverApp extends StatelessWidget {
  const SparxSolverApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'SparxSolver',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark().copyWith(
        scaffoldBackgroundColor: _background,
        colorScheme: const ColorScheme.dark(
          primary: _accent,
          secondary: Color(0xFF72C7C1),
          surface: _panel,
          onPrimary: Colors.white,
          onSurface: _ink,
        ),
        appBarTheme: const AppBarTheme(backgroundColor: _panel, foregroundColor: _ink),
        drawerTheme: const DrawerThemeData(backgroundColor: _panel),
        elevatedButtonTheme: ElevatedButtonThemeData(
          style: ElevatedButton.styleFrom(backgroundColor: _accentStrong, foregroundColor: Colors.white),
        ),
      ),
      home: const SparxBrowserScreen(),
    );
  }
}

class SparxBrowserScreen extends StatefulWidget {
  const SparxBrowserScreen({super.key});

  @override
  State<SparxBrowserScreen> createState() => _SparxBrowserScreenState();
}

class _SparxBrowserScreenState extends State<SparxBrowserScreen> {
  InAppWebViewController? _browserViewController;
  HttpServer? _server;
  int _currentTab = 0; // 0: Browser, 1: Extension Sidepanel
  
  final List<String> _logs = [];
  final List<Map<String, dynamic>> _bookworks = [];
  bool _isAutomationRunning = false;
  String _statusText = 'Idle';
  String _statusLevel = 'info';

  final Map<String, double> _settings = {
    'minDelaySeconds': 2,
    'maxDelaySeconds': 20,
    'requestTimeoutSeconds': 45,
    'retryDelaySeconds': 2,
    'maxRequestAttempts': 3,
  };

  @override
  void initState() {
    super.initState();
    _loadSavedState();
    _startLocalServer();
  }

  @override
  void dispose() {
    _server?.close(force: true);
    super.dispose();
  }

  Future<void> _loadSavedState() async {
    final prefs = await SharedPreferences.getInstance();
    final savedSettings = prefs.getString('ai_settings');
    final savedBookworks = prefs.getString('bookworks');
    if (savedSettings != null) {
      try {
        final decoded = jsonDecode(savedSettings) as Map<String, dynamic>;
        decoded.forEach((key, value) {
          if (_settings.containsKey(key)) _settings[key] = (value as num).toDouble();
        });
      } catch (_) {}
    }
    if (savedBookworks != null) {
      try {
        final decoded = jsonDecode(savedBookworks) as List<dynamic>;
        _bookworks.addAll(decoded.map((item) => Map<String, dynamic>.from(item as Map)));
      } catch (_) {}
    }
    setState(() {});
  }

  Future<void> _saveMobileState() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('ai_settings', jsonEncode(_settings));
    await prefs.setString('bookworks', jsonEncode(_bookworks));
  }

  Map<String, dynamic> _settingsPayload() => _settings.map((key, value) => MapEntry(key, value.round()));

  void _addLog(String text, String level) {
    final time = DateTime.now().toString().split(' ')[1].substring(0, 8);
    setState(() {
      _logs.insert(0, '[$time] $text');
    });
  }

  Future<void> _startLocalServer() async {
    try {
      _server = await HttpServer.bind(InternetAddress.loopbackIPv4, 3000);
      _server!.listen((HttpRequest request) async {
        final path = request.uri.path;
        final method = request.method;

        request.response.headers.add('Access-Control-Allow-Origin', '*');
        request.response.headers.add('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        request.response.headers.add('Access-Control-Allow-Headers', 'Content-Type');

        if (method == 'OPTIONS') {
          request.response.statusCode = HttpStatus.ok;
          await request.response.close();
          return;
        }

        if (path == '/status') {
          request.response.headers.contentType = ContentType.json;
          request.response.write(jsonEncode({
            'running': _isAutomationRunning,
            'status': {'text': _statusText, 'level': _statusLevel}
          }));
          await request.response.close();
        } else if (path == '/settings') {
          if (method == 'POST') {
            final content = await utf8.decoder.bind(request).join();
            try {
              final data = jsonDecode(content);
              if (data is Map) {
                data.forEach((k, v) {
                  if (_settings.containsKey(k)) _settings[k] = (v as num).toDouble();
                });
                _saveMobileState();
              }
            } catch (_) {}
          }
          request.response.headers.contentType = ContentType.json;
          request.response.write(jsonEncode({'settings': _settingsPayload()}));
          await request.response.close();
        } else if (path == '/start') {
          if (method == 'POST') {
            final content = await utf8.decoder.bind(request).join();
            try {
              final data = jsonDecode(content);
              final keys = (data['apiKeys'] as List<dynamic>? ?? []).map((e) => e.toString()).toList();
              if (data['settings'] != null) {
                final s = data['settings'] as Map<String, dynamic>;
                s.forEach((k, v) {
                  if (_settings.containsKey(k)) _settings[k] = (v as num).toDouble();
                });
                _saveMobileState();
              }
              if (keys.isNotEmpty) {
                setState(() => _isAutomationRunning = true);
                await _browserViewController?.evaluateJavascript(
                  source: "SparxEngine.startAutomation(${jsonEncode(keys)}, ${jsonEncode(_settingsPayload())});"
                );
                request.response.write('Started');
              } else {
                request.response.statusCode = HttpStatus.badRequest;
                request.response.write('No API keys provided');
              }
            } catch (e) {
              request.response.statusCode = HttpStatus.badRequest;
              request.response.write('Error: $e');
            }
          } else {
            request.response.statusCode = HttpStatus.methodNotAllowed;
          }
          await request.response.close();
        } else if (path == '/stop') {
          setState(() => _isAutomationRunning = false);
          await _browserViewController?.evaluateJavascript(source: "SparxEngine.stopAutomation();");
          request.response.write('Stopped');
          await request.response.close();
        } else if (path == '/bookwork') {
          if (method == 'POST') {
            final content = await utf8.decoder.bind(request).join();
            try {
              final data = jsonDecode(content);
              if (data['bookworks'] != null) {
                _handleBookworkSync(data);
              }
            } catch (_) {}
          }
          request.response.headers.contentType = ContentType.json;
          request.response.write(jsonEncode({'bookworks': _bookworks}));
          await request.response.close();
        } else {
          var assetPath = path == '/' || path.isEmpty ? '/sidepanel.html' : path;
          if (assetPath.startsWith('/')) assetPath = assetPath.substring(1);
          final fullAssetKey = 'assets/extension_dist/$assetPath';
          try {
            final byteData = await rootBundle.load(fullAssetKey);
            final bytes = byteData.buffer.asUint8List(byteData.offsetInBytes, byteData.lengthInBytes);
            
            if (assetPath.endsWith('.html')) {
              request.response.headers.contentType = ContentType.html;
            } else if (assetPath.endsWith('.js')) {
              request.response.headers.contentType = ContentType('application', 'javascript');
            } else if (assetPath.endsWith('.css')) {
              request.response.headers.contentType = ContentType('text', 'css');
            } else if (assetPath.endsWith('.png')) {
              request.response.headers.contentType = ContentType('image', 'png');
            } else if (assetPath.endsWith('.woff')) {
              request.response.headers.contentType = ContentType('font', 'woff');
            } else if (assetPath.endsWith('.woff2')) {
              request.response.headers.contentType = ContentType('font', 'woff2');
            } else if (assetPath.endsWith('.ttf')) {
              request.response.headers.contentType = ContentType('font', 'ttf');
            }
            request.response.add(bytes);
            await request.response.close();
          } catch (e) {
            request.response.statusCode = HttpStatus.notFound;
            request.response.write('Asset not found: $assetPath');
            await request.response.close();
          }
        }
      });
      _addLog('Embedded Dart HTTP Server running on port 3000', 'info');
    } catch (e) {
      _addLog('Failed to start local HTTP server: $e', 'error');
    }
  }

  void _handleBookworkSync(dynamic payload) {
    final entriesByCode = <String, Map<String, dynamic>>{};
    for (final item in (payload['bookworks'] as List<dynamic>? ?? [])) {
      final entry = Map<String, dynamic>.from(item as Map);
      final code = '${entry['code'] ?? ''}'.trim();
      if (code.isNotEmpty) entriesByCode[code.toLowerCase()] = entry;
    }
    setState(() {
      _bookworks
        ..clear()
        ..addAll(entriesByCode.values);
    });
    _saveMobileState();
  }

  void _showLogsWindow() {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: _background,
      builder: (context) => Container(
        height: MediaQuery.of(context).size.height * 0.75,
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Row(
                  children: [
                    const Icon(Icons.terminal, color: _accent),
                    const SizedBox(width: 8),
                    const Text('App Logs', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Colors.white)),
                    const SizedBox(width: 6),
                    Text('(${_logs.length})', style: const TextStyle(fontSize: 12, color: Colors.grey)),
                  ],
                ),
                Row(
                  children: [
                    IconButton(
                      icon: const Icon(Icons.delete_outline, color: Colors.grey),
                      onPressed: () => setState(() => _logs.clear()),
                      tooltip: 'Clear Logs',
                    ),
                    IconButton(
                      icon: const Icon(Icons.close, color: Colors.white70),
                      onPressed: () => Navigator.pop(context),
                    ),
                  ],
                )
              ],
            ),
            const Divider(),
            Expanded(
              child: ListView.builder(
                itemCount: _logs.length,
                itemBuilder: (context, index) {
                  final logText = _logs[index];
                  Color logColor = Colors.white70;
                  if (logText.contains('[JS ERR]') || logText.contains('Error')) {
                    logColor = Colors.redAccent;
                  } else if (logText.contains('[JS WARN]')) {
                    logColor = const Color(0xFFF0B35B);
                  } else if (logText.contains('🤖 AI Tool:')) {
                    logColor = const Color(0xFF72B7D8);
                  } else if (logText.contains('✓ Question Finished')) {
                    logColor = const Color(0xFF72C7C1);
                  }

                  return Padding(
                    padding: const EdgeInsets.symmetric(vertical: 2.0),
                    child: SelectableText(
                      logText,
                      style: TextStyle(fontFamily: 'monospace', fontSize: 11, color: logColor),
                    ),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: _panel,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('SparxSolver Mobile', style: TextStyle(fontWeight: FontWeight.bold)),
            Text(_statusText, style: TextStyle(fontSize: 11, color: _statusLevel == 'warn' ? const Color(0xFFF0B35B) : _mutedInk)),
          ],
        ),
        actions: [
          IconButton(
            icon: Stack(
              children: [
                const Icon(Icons.terminal),
                if (_logs.isNotEmpty)
                  Positioned(
                    right: 0,
                    top: 0,
                    child: Container(
                      padding: const EdgeInsets.all(2),
                      decoration: const BoxDecoration(color: _accent, shape: BoxShape.circle),
                      constraints: const BoxConstraints(minWidth: 10, minHeight: 10),
                    ),
                  )
              ],
            ),
            onPressed: _showLogsWindow,
            tooltip: 'App Logs Window',
          ),
        ],
      ),
      body: IndexedStack(
        index: _currentTab,
        children: [
          // Webview 1: Sparx Browser View
          InAppWebView(
            initialUrlRequest: URLRequest(url: WebUri("https://sparxmaths.uk")),
            onWebViewCreated: (controller) {
              _browserViewController = controller;
              controller.addJavaScriptHandler(
                handlerName: 'SparxBridge',
                callback: (args) {
                  final data = args[0];
                  final String type = data['type'] ?? '';
                  final payload = data['payload'] ?? {};

                  if (type == 'log') {
                    _addLog(payload['text'] ?? '', payload['level'] ?? 'info');
                  } else if (type == 'bookwork_add') {
                    _handleBookworkSync({'bookworks': [..._bookworks, payload]});
                  } else if (type == 'bookwork_sync') {
                    _handleBookworkSync(payload);
                  } else if (type == 'status') {
                    setState(() {
                      _statusText = payload['text'] ?? 'Idle';
                      _statusLevel = payload['level'] ?? 'info';
                    });
                  }
                },
              );
            },
            onLoadStop: (controller, url) async {
              final jsCode = await rootBundle.loadString('assets/sparx_engine_bridge.js');
              await controller.evaluateJavascript(source: jsCode);
              await controller.evaluateJavascript(source: 'SparxEngine.setBookworks(${jsonEncode(_bookworks)});');
              _addLog('Loaded Sparx Engine into browser webview.', 'info');
            },
          ),
          
          // Webview 2: Extension Sidepanel View (AI Settings & Bookwork Dashboard)
          InAppWebView(
            initialUrlRequest: URLRequest(url: WebUri("http://localhost:3000/sidepanel.html")),
            onWebViewCreated: (controller) {},
          ),
        ],
      ),
      bottomNavigationBar: BottomNavigationBar(
        currentIndex: _currentTab,
        onTap: (index) => setState(() => _currentTab = index),
        backgroundColor: _panel,
        selectedItemColor: _accent,
        unselectedItemColor: _mutedInk,
        items: const [
          BottomNavigationBarItem(
            icon: Icon(Icons.public),
            label: 'Sparx Browser',
          ),
          BottomNavigationBarItem(
            icon: Icon(Icons.extension),
            label: 'Extension Dashboard',
          ),
        ],
      ),
    );
  }
}
