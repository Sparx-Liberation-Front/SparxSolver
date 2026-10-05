import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const SparxSolverApp());
}

class SparxSolverApp extends StatelessWidget {
  const SparxSolverApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'SparxSolver Mobile',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark().copyWith(
        scaffoldBackgroundColor: const Color(0xFF0F0F1A),
        colorScheme: const ColorScheme.dark(
          primary: Color(0xFF6C63FF),
          secondary: Color(0xFFA78BFA),
          surface: Color(0xFF1A1A2E),
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
  InAppWebViewController? _webViewController;
  final TextEditingController _apiKeyController = TextEditingController();
  final List<String> _logs = [];
  final List<Map<String, dynamic>> _bookworks = [];
  bool _isAutomationRunning = false;
  String _statusText = 'Idle';
  String _statusLevel = 'info';
  bool _showApiKeys = false;
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
    _loadSavedApiKeys();
  }

  Future<void> _loadSavedApiKeys() async {
    final prefs = await SharedPreferences.getInstance();
    final keys = prefs.getString('api_keys') ?? '';
    final savedSettings = prefs.getString('ai_settings');
    final savedBookworks = prefs.getString('bookworks');
    if (savedSettings != null) {
      final decoded = jsonDecode(savedSettings) as Map<String, dynamic>;
      decoded.forEach((key, value) {
        if (_settings.containsKey(key)) _settings[key] = (value as num).toDouble();
      });
    }
    if (savedBookworks != null) {
      final decoded = jsonDecode(savedBookworks) as List<dynamic>;
      _bookworks.addAll(decoded.map((item) => Map<String, dynamic>.from(item as Map)));
    }
    setState(() {
      _apiKeyController.text = keys;
    });
  }

  Future<void> _saveApiKeys(String keys) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('api_keys', keys);
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

  void _toggleAutomation() async {
    final rawKeys = _apiKeyController.text.trim();
    if (rawKeys.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please enter at least one Gemini API Key!')),
      );
      return;
    }

    final keysList = rawKeys.split('\n').map((e) => e.trim()).where((e) => e.isNotEmpty).toList();
    await _saveApiKeys(rawKeys);

    if (_isAutomationRunning) {
      await _webViewController?.evaluateJavascript(source: "SparxEngine.stopAutomation();");
      setState(() => _isAutomationRunning = false);
    } else {
      final jsonKeys = jsonEncode(keysList);
      final jsonSettings = jsonEncode(_settingsPayload());
      await _webViewController?.evaluateJavascript(source: "SparxEngine.startAutomation($jsonKeys, $jsonSettings);");
      setState(() => _isAutomationRunning = true);
    }
  }

  void _setSetting(String key, String value) {
    final parsed = double.tryParse(value);
    if (parsed == null) return;
    setState(() {
      _settings[key] = parsed.clamp(key == 'maxRequestAttempts' ? 1 : 0, key == 'requestTimeoutSeconds' ? 300 : key == 'maxRequestAttempts' ? 10 : 300).toDouble();
      if (key == 'minDelaySeconds' && _settings['maxDelaySeconds']! < parsed) _settings['maxDelaySeconds'] = parsed;
      if (key == 'maxDelaySeconds' && parsed < _settings['minDelaySeconds']!) _settings['minDelaySeconds'] = parsed;
    });
    _saveMobileState();
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

  Future<void> _deleteBookwork(String code) async {
    await _webViewController?.evaluateJavascript(source: 'SparxEngine.deleteBookwork(${jsonEncode(code)});');
  }

  Future<void> _clearBookworks() async {
    await _webViewController?.evaluateJavascript(source: 'SparxEngine.clearBookworks();');
  }

  Future<void> _saveBookworkInfo(String code, String info) async {
    await _webViewController?.evaluateJavascript(source: 'SparxEngine.updateBookworkInfo(${jsonEncode(code)}, ${jsonEncode(info)});');
  }

  String _bookworkMarkdown() => _bookworks.map((entry) => [
        '## Bookwork ${entry['code']}',
        entry['savedAt'] == null ? '' : '**Saved:** ${entry['savedAt']}',
        '**Answer:** ${entry['answer']}',
        '',
        '### Working',
        (entry['working'] as String?)?.isNotEmpty == true ? entry['working'] : 'Working not captured.',
        (entry['info'] as String?)?.isNotEmpty == true ? '\n### Notes\n${entry['info']}' : ''
      ].join('\n')).join('\n\n') + '\n';

  Future<void> _showBookworkExport() async {
    final export = _bookworkMarkdown();
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Bookwork Markdown'),
        content: SizedBox(width: 560, child: SingleChildScrollView(child: SelectableText(export))),
        actions: [
          TextButton(onPressed: () { Clipboard.setData(ClipboardData(text: export)); Navigator.pop(context); }, child: const Text('Copy')),
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Close')),
        ],
      ),
    );
  }

  Widget _settingField(String label, String key) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: TextFormField(
        initialValue: _settings[key]!.round().toString(),
        keyboardType: TextInputType.number,
        decoration: InputDecoration(labelText: label, border: const OutlineInputBorder()),
        onChanged: (value) => _setSetting(key, value),
      ),
    );
  }

  @override
  void dispose() {
    _apiKeyController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: const Color(0xFF1A1A2E),
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('SparxSolver', style: TextStyle(fontWeight: FontWeight.bold)),
            Text(_statusText, style: TextStyle(fontSize: 11, color: _statusLevel == 'warn' ? Colors.amber : Colors.white70)),
          ],
        ),
        actions: [
          IconButton(
            icon: Icon(_isAutomationRunning ? Icons.stop_circle : Icons.play_circle, 
                 color: _isAutomationRunning ? Colors.redAccent : const Color(0xFF4ADE80)),
            onPressed: _toggleAutomation,
          ),
          Builder(
            builder: (context) => IconButton(
              icon: Stack(
                children: [
                  const Icon(Icons.terminal),
                  if (_logs.isNotEmpty)
                    Positioned(
                      right: 0,
                      top: 0,
                      child: Container(
                        padding: const EdgeInsets.all(2),
                        decoration: const BoxDecoration(color: Color(0xFF6C63FF), shape: BoxShape.circle),
                        constraints: const BoxConstraints(minWidth: 10, minHeight: 10),
                      ),
                    )
                ],
              ),
              onPressed: () => Scaffold.of(context).openDrawer(),
              tooltip: 'Live Logs',
            ),
          ),
          Builder(
            builder: (context) => IconButton(
              icon: const Icon(Icons.settings),
              onPressed: () => Scaffold.of(context).openEndDrawer(),
              tooltip: 'Settings & Keys',
            ),
          ),
        ],
      ),
      drawer: Drawer(
        backgroundColor: const Color(0xFF0F0F1A),
        child: SafeArea(
          child: Column(
            children: [
              Container(
                padding: const EdgeInsets.all(16),
                color: const Color(0xFF1A1A2E),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.terminal, color: Color(0xFFA78BFA)),
                        const SizedBox(width: 8),
                        const Text('Live Logs', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: Colors.white)),
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
                          onPressed: () => Navigator.of(context).pop(),
                        ),
                      ],
                    )
                  ],
                ),
              ),
              Expanded(
                child: Container(
                  padding: const EdgeInsets.all(8.0),
                  child: ListView.builder(
                    itemCount: _logs.length,
                    itemBuilder: (context, index) {
                      final logText = _logs[index];
                      Color logColor = Colors.white70;
                      if (logText.contains('[JS ERR]') || logText.contains('Error')) {
                        logColor = Colors.redAccent;
                      } else if (logText.contains('[JS WARN]')) {
                        logColor = Colors.amberAccent;
                      } else if (logText.contains('🤖 AI Tool:')) {
                        logColor = const Color(0xFF60A5FA);
                      } else if (logText.contains('✓ Question Finished')) {
                        logColor = const Color(0xFF4ADE80);
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
              ),
            ],
          ),
        ),
      ),
      endDrawer: Drawer(
        backgroundColor: const Color(0xFF1A1A2E),
        child: Padding(
          padding: const EdgeInsets.all(16.0),
          child: ListView(
            children: [
              const Text('AI Settings', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Colors.white)),
              const SizedBox(height: 6),
              const Text('Enter one or more API keys (one per line):', style: TextStyle(fontSize: 12, color: Colors.grey)),
              const SizedBox(height: 12),
              TextField(
                controller: _apiKeyController,
                maxLines: _showApiKeys ? 4 : 1,
                obscureText: !_showApiKeys,
                style: const TextStyle(fontSize: 12, fontFamily: 'monospace'),
                decoration: const InputDecoration(
                  border: OutlineInputBorder(),
                  hintText: 'AIzaSy...',
                  fillColor: Color(0xFF0F0F1A),
                  filled: true,
                  suffixIcon: Icon(Icons.key),
                ),
              ),
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Show API keys', style: TextStyle(fontSize: 12)),
                value: _showApiKeys,
                onChanged: (value) => setState(() => _showApiKeys = value ?? false),
              ),
              const Divider(),
              _settingField('Minimum thinking delay (seconds)', 'minDelaySeconds'),
              _settingField('Maximum thinking delay (seconds)', 'maxDelaySeconds'),
              _settingField('Gemini request timeout (seconds)', 'requestTimeoutSeconds'),
              _settingField('Wait between retries (seconds)', 'retryDelaySeconds'),
              _settingField('Maximum request attempts', 'maxRequestAttempts'),
              const SizedBox(height: 20),
              ElevatedButton.icon(
                onPressed: _toggleAutomation,
                style: ElevatedButton.styleFrom(
                  backgroundColor: _isAutomationRunning ? Colors.redAccent : const Color(0xFF6C63FF),
                  padding: const EdgeInsets.symmetric(vertical: 14),
                ),
                icon: Icon(_isAutomationRunning ? Icons.stop : Icons.play_arrow),
                label: Text(_isAutomationRunning ? 'Stop Automation' : 'Start Automation'),
              ),
              const SizedBox(height: 24),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text('Bookwork', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                  Row(children: [
                    IconButton(onPressed: _showBookworkExport, icon: const Icon(Icons.copy, size: 19), tooltip: 'Copy Markdown'),
                    IconButton(onPressed: _clearBookworks, icon: const Icon(Icons.delete_sweep, size: 19), tooltip: 'Clear all'),
                  ]),
                ],
              ),
              const Divider(),
              if (_bookworks.isEmpty) const Text('No saved bookworks yet.', style: TextStyle(fontSize: 12, color: Colors.grey)),
              ..._bookworks.map((b) => Card(
                color: const Color(0xFF252542),
                child: ExpansionTile(
                  title: Text('Code ${b['code']}', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                  subtitle: Text('Answer: ${b['answer']}', style: const TextStyle(color: Color(0xFFA78BFA), fontSize: 12)),
                  trailing: IconButton(
                    icon: const Icon(Icons.delete_outline, color: Colors.redAccent),
                    onPressed: () => _deleteBookwork('${b['code']}'),
                  ),
                  children: [
                    if ((b['working'] as String? ?? '').isNotEmpty)
                      Padding(padding: const EdgeInsets.all(12), child: SelectableText(b['working'] as String)),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
                      child: TextFormField(
                        initialValue: b['info'] as String? ?? '',
                        maxLines: 3,
                        decoration: const InputDecoration(labelText: 'Notes', border: OutlineInputBorder()),
                        onChanged: (value) => b['info'] = value,
                        onFieldSubmitted: (value) => _saveBookworkInfo('${b['code']}', value),
                      ),
                    ),
                    Align(
                      alignment: Alignment.centerRight,
                      child: TextButton(onPressed: () => _saveBookworkInfo('${b['code']}', b['info'] as String? ?? ''), child: const Text('Save notes')),
                    ),
                  ],
                ),
              )),
            ],
          ),
        ),
      ),
      body: InAppWebView(
        initialUrlRequest: URLRequest(url: WebUri("https://sparxmaths.uk")),
        onWebViewCreated: (controller) {
          _webViewController = controller;

          // Set up JavaScript bridge handler
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
          // Inject embedded Sparx Engine JS script into page context
          final jsCode = await rootBundle.loadString('assets/sparx_engine_bridge.js');
          await controller.evaluateJavascript(source: jsCode);
          await controller.evaluateJavascript(source: 'SparxEngine.setBookworks(${jsonEncode(_bookworks)});');
          _addLog('Loaded Sparx Engine into page.', 'info');
        },
      ),
    );
  }
}
