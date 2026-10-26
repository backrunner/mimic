package integration_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/hibiken/asynq"
	"memstation/apps/server/internal/bootstrap"
	"memstation/apps/server/internal/domain"
	"memstation/apps/server/internal/runtimeconfig"
	"memstation/apps/server/internal/security"
	"memstation/apps/server/internal/service/aibroker"
	"memstation/apps/server/internal/service/analysis"
	"memstation/apps/server/internal/service/apikey"
	"memstation/apps/server/internal/service/ingestion"
	"memstation/apps/server/internal/service/lifecycle"
	memoryservice "memstation/apps/server/internal/service/memory"
	"memstation/apps/server/internal/service/memorygen"
	"memstation/apps/server/internal/service/memoryllm"
	"memstation/apps/server/internal/store/deletionjournal"
	sqlstore "memstation/apps/server/internal/store/sql"
	vectorstore "memstation/apps/server/internal/store/vector"
	httptransport "memstation/apps/server/internal/transport/http"
	"memstation/apps/server/internal/worker"
	"memstation/apps/server/tests/testutil/mockbroker"
)

func TestMimicTypeScriptJoint(t *testing.T) {
	root := os.Getenv("MIMIC_JOINT_ROOT")
	if root == "" {
		t.Skip("MIMIC_JOINT_ROOT required")
	}
	db := independentDatabase(t)
	handle := runtimeconfig.NewStaticDBHandle(db)
	ctx := context.Background()
	admin := security.WithAdmin(ctx, true)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	keys := apikey.NewService(handle)
	identity := keys.Identities()
	owner := "joint-owner"
	if _, err := db.Exec(`INSERT INTO users(id,name) VALUES($1,'Joint fixture')`, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := identity.Personal(admin, owner); err != nil {
		t.Fatal(err)
	}
	var agent domain.Agent
	bindings := []map[string]any{}
	for i, name := range []string{"A", "B"} {
		ws, err := identity.CreateWorkspace(admin, domain.Workspace{UserID: owner, Name: name, Kind: "group"})
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			agent, err = identity.CreateWorkspaceAgent(admin, owner, ws.ID, "Mimic joint", ws.Capabilities)
		} else {
			_, err = identity.SetGrant(admin, domain.WorkspaceGrant{UserID: owner, WorkspaceID: ws.ID, AgentID: agent.ID, Capabilities: ws.Capabilities})
		}
		if err != nil {
			t.Fatal(err)
		}
		integration, err := identity.PutIntegration(admin, domain.IntegrationConfig{UserID: owner, WorkspaceID: ws.ID, Name: "Mimic joint", Kind: "chat", AgentID: agent.ID, ExternalSpaceID: "room", AllowedEventTypes: []string{"message.created", "message.edited", "message.deleted"}})
		if err != nil {
			t.Fatal(err)
		}
		bindings = append(bindings, map[string]any{"workspaceId": "joint-" + string(rune('0'+i)), "remoteWorkspaceId": ws.ID, "integrationId": integration.ID, "externalSpaceId": "room", "partitionId": "", "audienceActorIds": []string{}})
	}
	_, token, err := keys.CreateWithOptions(admin, owner, apikey.CreateOptions{Name: "joint", AgentID: agent.ID, WorkspaceID: agent.DefaultWorkspaceID})
	if err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewServer(&mockbroker.Handler{Credential: "fixture-broker"})
	defer upstream.Close()
	seedPath := filepath.Join(t.TempDir(), "seed.json")
	seed, _ := json.Marshal(map[string]any{"bindings": bindings, "key": token, "upstream": upstream.URL, "report": os.Getenv("MIMIC_JOINT_REPORT")})
	if err = os.WriteFile(seedPath, seed, 0600); err != nil {
		t.Fatal(err)
	}
	childCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	command := exec.CommandContext(childCtx, "node", "--import", "tsx", "tests/memory-joint-driver.ts")
	command.Dir = root
	command.Env = append(os.Environ(), "MIMIC_JOINT_SEED="+seedPath)
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	if err = command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = command.Process.Kill() }()
	var ready struct {
		URL string `json:"url"`
	}
	for deadline := time.Now().Add(20 * time.Second); time.Now().Before(deadline); {
		raw, e := os.ReadFile(seedPath + ".ready")
		if e == nil && json.Unmarshal(raw, &ready) == nil {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if ready.URL == "" {
		t.Fatal("Mimic broker did not start")
	}
	journal, err := deletionjournal.New(filepath.Join(t.TempDir(), "deletions.jsonl"), "joint-fixture")
	if err != nil {
		t.Fatal(err)
	}
	lifeRepo := sqlstore.NewMemoryLifecycleRepository(handle)
	lifeRepo.SetDeletionJournal(journal)
	if err = lifeRepo.EnsureDeletionJournal(ctx); err != nil {
		t.Fatal(err)
	}
	gate := sqlstore.NewMemoryGate(lifeRepo)
	ingestRepo := sqlstore.NewDurableIngestionRepository(handle)
	ingestRepo.SetDeletionJournal(journal)
	ingest := ingestion.NewService(ingestRepo, 8192)
	life := lifecycle.NewService(lifeRepo)
	life.SetReady(gate.Check)
	life.SetRuntime(domain.MemoryRuntime{AIBackend: "broker", UsageAuthority: "broker"})
	broker, err := aibroker.New(aibroker.Config{BaseURL: ready.URL + "/v1", Credential: "joint-broker", Roles: map[string]string{"summary": "memory.summary", "analysis": "memory.analysis", "embedding": "memory.embedding", "rerank": "memory.rerank"}, Embedding: domain.EmbeddingIdentity{ModelVersion: "fixture-embedding-v1", Dimensions: 3, Fingerprint: "fixture-embedding-v1:3"}, Timeout: 5 * time.Second}, sqlstore.NewAICallRepository(handle))
	if err != nil {
		t.Fatal(err)
	}
	llm := memoryllm.NewClient(nil, nil, 5*time.Second)
	llm.SetRuntime(broker)
	memories := sqlstore.NewPostgresMemoryRepository(db)
	conversations := sqlstore.NewPostgresConversationRepository(db)
	vectors := vectorstore.NewPGVectorStore(handle)
	vectors.SetEmbedder(broker)
	gens := memorygen.NewService(handle, "memory.embedding")
	engine := memoryservice.NewEngine(memories, vectors)
	engine.SetGenerationService(gens)
	engine.SetReranker(broker)
	engine.SetRerankConfig(memoryservice.RerankConfig{Model: "memory.rerank", BlendWeight: .35})
	memory := memoryservice.NewService(engine, memories)
	memory.SetGenerationService(gens)
	memory.SetVectorStore(vectors)
	memory.SetWatermarks(ingestRepo)
	scorer := memoryservice.NewScorerWithGenerator(llm)
	memory.SetScorer(scorer)
	opt, err := bootstrap.AsynqRedisOpt(os.Getenv("MEMSTATION_TEST_REDIS_URL"))
	if err != nil {
		t.Fatal(err)
	}
	client := asynq.NewClient(opt)
	defer client.Close()
	inspector := asynq.NewInspector(opt)
	defer inspector.Close()
	queue := "mimic-joint-" + uuid.NewString()
	publisher := isolatedQueue{worker.NewPublisher(logger, client), queue}
	relay := worker.NewRelay(logger, sqlstore.NewPostgresOutboxRepository(db), publisher)
	relay.SetTaskAuthority(ingestRepo)
	mux := worker.NewServeMux(logger, worker.Services{Scorer: scorer, DataReady: gate.Check, TaskAuthority: ingestRepo, Jobs: ingestRepo, AcknowledgeReceipt: ingestRepo.AcknowledgeReceipt, ProcessOperation: lifeRepo.ProcessOperation, Conversations: conversations, Memories: memories, MemoryService: memory, Generations: gens, Vectors: vectors, Publisher: publisher, Analysis: analysis.NewService(llm), AllowedKeyMemoryKeys: map[string]struct{}{}})
	workerServer := asynq.NewServer(opt, asynq.Config{Concurrency: 4, Queues: map[string]int{queue: 1}, RetryDelayFunc: worker.MemoryRetryDelay, ShutdownTimeout: time.Second, TaskCheckInterval: 100 * time.Millisecond})
	if err = workerServer.Start(mux); err != nil {
		t.Fatal(err)
	}
	defer func() { workerServer.Shutdown(); _ = inspector.DeleteQueue(queue, true) }()
	auth := security.Authenticator{LookupPrincipal: keys.LookupPrincipalByHash, ResolveAccess: keys.ResolveAccess}
	api := httptest.NewServer(httptransport.NewRouter(httptransport.Dependencies{Logger: logger, Auth: auth, APIKeys: keys, Ingestion: ingest, Lifecycle: life, Memory: memory, AIUsage: aibroker.NewUsageService(sqlstore.NewAICallRepository(handle), broker), DataReady: gate.Check}))
	defer api.Close()
	if err = os.WriteFile(seedPath+".url", []byte(api.URL), 0600); err != nil {
		t.Fatal(err)
	}
	completed := make(chan error, 1)
	go func() { completed <- command.Wait() }()
	for {
		select {
		case err = <-completed:
			if err != nil {
				t.Fatal(err)
			}
			return
		case <-time.After(50 * time.Millisecond):
			if err = relay.Flush(ctx); err != nil {
				t.Fatal(err)
			}
		case <-childCtx.Done():
			t.Fatal("joint timeout")
		}
	}
}
