import { useState, useRef, useEffect, useCallback } from "react";
import { supabase } from "./supabase";

const MUSCLE_GROUPS = ["胸", "背", "肩", "手臂", "腿", "核心", "有氧"];
const MEAL_TYPES = ["早餐", "午餐", "晚餐", "加餐"];
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function todayKey() { return new Date().toISOString().slice(0, 10); }

function formatDate(key) {
  const d = new Date(key + "T00:00:00");
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
}

function getDayData(data, key) { return data[key] || { gym: [], meals: [], gymDone: false }; }

function getWeekKey(dateKey) {
  const d = new Date(dateKey);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.getFullYear(), d.getMonth(), diff).toISOString().slice(0, 10);
}

// ── Photo upload ─────────────────────────────────────────────────────────────
async function uploadPhoto(userId, dataUrl) {
  // Convert base64 data URL to blob
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const ext = blob.type === "image/png" ? "png" : "jpg";
  const path = `${userId}/${Date.now()}.${ext}`;

  const { error } = await supabase.storage.from("meal-photos").upload(path, blob, {
    contentType: blob.type,
    upsert: false,
  });
  if (error) { console.error("Photo upload failed:", error); return null; }

  const { data: urlData } = supabase.storage.from("meal-photos").getPublicUrl(path);
  return urlData.publicUrl;
}

// ── Supabase data hooks ──────────────────────────────────────────────────────
function useAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
      setLoading(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  return { user, loading };
}

function useCloudData(user) {
  const [data, setData] = useState({});
  const [plans, setPlans] = useState({});
  const [loaded, setLoaded] = useState(false);

  // Load all records from Supabase
  const reload = useCallback(async () => {
    if (!user) return;
    const [recordsRes, plansRes] = await Promise.all([
      supabase.from("daily_records").select("*").eq("user_id", user.id),
      supabase.from("weekly_plans").select("*").eq("user_id", user.id),
    ]);

    const d = {};
    (recordsRes.data || []).forEach(r => {
      d[r.date_key] = { gym: r.gym || [], meals: r.meals || [], gymDone: r.gym_done };
    });
    setData(d);

    const p = {};
    (plansRes.data || []).forEach(r => {
      p[r.week_key] = { menu: r.menu, groceries: r.groceries, source: r.source };
    });
    setPlans(p);
    setLoaded(true);
  }, [user]);

  useEffect(() => { reload(); }, [reload]);

  const updateDay = async (dateKey, newDayData) => {
    setData(prev => ({ ...prev, [dateKey]: newDayData }));

    // Upload any base64 photos to Storage, replace with public URL
    const mealsForCloud = await Promise.all(
      (newDayData.meals || []).map(async (m) => {
        if (m.photo && m.photo.startsWith("data:")) {
          const url = await uploadPhoto(user.id, m.photo);
          return { ...m, photo: url };
        }
        return m;
      })
    );

    // Also update local state with the URLs
    setData(prev => ({ ...prev, [dateKey]: { ...newDayData, meals: mealsForCloud } }));

    await supabase.from("daily_records").upsert({
      user_id: user.id,
      date_key: dateKey,
      gym: newDayData.gym || [],
      meals: mealsForCloud,
      gym_done: newDayData.gymDone || false,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,date_key" });
  };

  const updatePlan = async (weekKey, planData) => {
    setPlans(prev => ({ ...prev, [weekKey]: planData }));
    await supabase.from("weekly_plans").upsert({
      user_id: user.id,
      week_key: weekKey,
      menu: planData.menu || "",
      groceries: planData.groceries || "",
      source: planData.source || "",
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,week_key" });
  };

  return { data, plans, loaded, updateDay, updatePlan };
}

function useRecipes(user) {
  const [recipes, setRecipes] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase.from("recipes").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
    setRecipes(data || []);
    setLoaded(true);
  }, [user]);

  useEffect(() => { reload(); }, [reload]);

  const addRecipe = async (recipe) => {
    const row = { user_id: user.id, ...recipe };
    const { data } = await supabase.from("recipes").insert(row).select().single();
    if (data) setRecipes(prev => [data, ...prev]);
  };

  const updateRecipe = async (id, updates) => {
    const { data } = await supabase.from("recipes").update(updates).eq("id", id).select().single();
    if (data) setRecipes(prev => prev.map(r => r.id === id ? data : r));
  };

  const deleteRecipe = async (id) => {
    await supabase.from("recipes").delete().eq("id", id);
    setRecipes(prev => prev.filter(r => r.id !== id));
  };

  return { recipes, loaded, addRecipe, updateRecipe, deleteRecipe };
}

// ── Auth Screen ──────────────────────────────────────────────────────────────
function AuthScreen() {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(""); setMessage("");
    if (isLogin) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError(error.message);
    } else {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) setError(error.message);
      else setMessage("注册成功！请检查邮箱确认后登录。");
    }
  };

  return (
    <div className="app-root" style={{ display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Inter', 'PingFang SC', -apple-system, sans-serif" }}>
      <InjectCSS />
      <div style={{ width: "100%", maxWidth: 380, padding: 20 }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontSize: 32, fontWeight: 900, background: "linear-gradient(135deg, #2563eb, #60a5fa)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Tracker</div>
          <div style={{ color: "#94a3b8", fontSize: 14, marginTop: 4 }}>健身 & 饮食记录</div>
        </div>

        <div className="card" style={{ padding: 24 }}>
          <div className="tab-bar" style={{ marginBottom: 20 }}>
            <button onClick={() => setIsLogin(true)} className={`tab-btn ${isLogin ? "active" : ""}`}>登录</button>
            <button onClick={() => setIsLogin(false)} className={`tab-btn ${!isLogin ? "active" : ""}`}>注册</button>
          </div>

          <form onSubmit={handleSubmit}>
            <input value={email} onChange={e => setEmail(e.target.value)}
              placeholder="Email" type="email" className="input" style={{ marginBottom: 10 }} />
            <input value={password} onChange={e => setPassword(e.target.value)}
              placeholder="Password" type="password" className="input" style={{ marginBottom: 10 }} />

            {error && <div style={{ color: "#ef4444", fontSize: 13, marginBottom: 8, padding: "8px 12px", background: "#fef2f2", borderRadius: 8 }}>{error}</div>}
            {message && <div style={{ color: "#2563eb", fontSize: 13, marginBottom: 8, padding: "8px 12px", background: "#eff6ff", borderRadius: 8 }}>{message}</div>}

            <button type="submit" className="btn-primary" style={{ marginTop: 4 }}>
              {isLogin ? "登录" : "注册"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

// ── Global CSS ───────────────────────────────────────────────────────────────
const GLOBAL_CSS = `
  * { box-sizing: border-box; }
  input[type="number"]::-webkit-inner-spin-button,
  input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  input[type="number"] { -moz-appearance: textfield; }

  .app-root {
    background: linear-gradient(160deg, #f0f4ff 0%, #fafbff 40%, #fff 100%);
    min-height: 100vh;
  }

  @media (min-width: 768px) {
    .app-root { max-width: 900px !important; }
    .main-layout { display: flex !important; gap: 24px !important; }
    .main-layout > * { flex: 1; min-width: 0; }
  }

  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.35);
    display: flex; align-items: center; justify-content: center;
    z-index: 100; padding: 16px; backdrop-filter: blur(4px);
  }
  .modal-box {
    background: #fff; border-radius: 20px; padding: 28px; width: 100%; max-width: 520px;
    max-height: 85vh; overflow-y: auto;
    box-shadow: 0 24px 80px rgba(37,99,235,0.12), 0 0 0 1px rgba(37,99,235,0.06);
  }

  .card {
    background: #fff; border-radius: 14px; padding: 16px; margin-bottom: 12px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 0 0 1px rgba(0,0,0,0.03);
    transition: box-shadow 0.15s;
  }
  .card:hover { box-shadow: 0 4px 12px rgba(37,99,235,0.08), 0 0 0 1px rgba(37,99,235,0.08); }

  .card-flat {
    background: rgba(255,255,255,0.7); border-radius: 14px; padding: 16px; margin-bottom: 12px;
    border: 1px solid #eef2f7;
  }

  .section-title {
    font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
    color: #94a3b8; margin-bottom: 12px;
  }

  .tab-bar {
    display: flex; gap: 4px; padding: 4px;
    background: #f1f5f9; border-radius: 12px; margin-bottom: 20px;
  }
  .tab-btn {
    flex: 1; padding: 10px 0; border: none; cursor: pointer; font-size: 14px; font-weight: 700;
    border-radius: 10px; transition: all 0.2s;
  }
  .tab-btn.active { background: #2563eb; color: #fff; box-shadow: 0 2px 8px rgba(37,99,235,0.25); }
  .tab-btn:not(.active) { background: transparent; color: #94a3b8; }

  .btn-primary {
    width: 100%; padding: 12px 0; background: linear-gradient(135deg, #2563eb, #3b82f6);
    color: #fff; border: none; border-radius: 12px; font-weight: 800; font-size: 15px;
    cursor: pointer; margin-top: 10px; box-shadow: 0 4px 14px rgba(37,99,235,0.25);
    transition: transform 0.1s, box-shadow 0.15s;
  }
  .btn-primary:active { transform: scale(0.98); }

  .btn-secondary {
    width: 100%; padding: 12px 0; background: linear-gradient(135deg, #60a5fa, #93c5fd);
    color: #fff; border: none; border-radius: 12px; font-weight: 800; font-size: 15px;
    cursor: pointer; margin-top: 10px; box-shadow: 0 4px 14px rgba(96,165,250,0.25);
    transition: transform 0.1s;
  }
  .btn-secondary:active { transform: scale(0.98); }

  .input {
    width: 100%; background: #f8fafc; border: 1.5px solid #e2e8f0;
    border-radius: 10px; padding: 10px 12px; color: #334155; font-size: 14px;
    outline: none; box-sizing: border-box; margin-bottom: 8px; transition: border-color 0.15s;
  }
  .input:focus { border-color: #93c5fd; background: #fff; }
  .input::placeholder { color: #94a3b8; }

  .chip {
    border: none; border-radius: 10px; padding: 6px 14px; font-size: 13px;
    cursor: pointer; font-weight: 600; transition: all 0.15s;
  }
  .chip-active { background: #2563eb; color: #fff; box-shadow: 0 2px 8px rgba(37,99,235,0.2); }
  .chip-inactive { background: #f1f5f9; color: #64748b; }
  .chip-active-light { background: #60a5fa; color: #fff; box-shadow: 0 2px 8px rgba(96,165,250,0.2); }
`;

function InjectCSS() {
  return <style dangerouslySetInnerHTML={{ __html: GLOBAL_CSS }} />;
}

// ── Calendar (gym only) ──────────────────────────────────────────────────────
function GymCalendar({ data, onSelect, selected }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = Array(firstDay).fill(null).concat(
    Array.from({ length: daysInMonth }, (_, i) => i + 1)
  );
  const pad = (n) => String(n).padStart(2, "0");
  const keyFor = (d) => `${year}-${pad(month + 1)}-${pad(d)}`;

  const monthKey = `${year}-${pad(month + 1)}`;
  const monthGymCount = Object.keys(data).filter(k => k.startsWith(monthKey) && data[k].gymDone).length;

  return (
    <div className="card" style={{ padding: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <button onClick={() => { if (month === 0) { setMonth(11); setYear(y => y-1); } else setMonth(m=>m-1); }}
          style={{ background: "#f1f5f9", border: "none", color: "#475569", borderRadius: 10, width: 34, height: 34, cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>‹</button>
        <div style={{ textAlign: "center" }}>
          <div style={{ color: "#1e293b", fontWeight: 800, fontSize: 16 }}>{MONTH_NAMES[month]}</div>
          <div style={{ fontSize: 12, color: "#2563eb", fontWeight: 600, marginTop: 2 }}>
            {monthGymCount > 0 ? `${monthGymCount} workouts this month` : "Let's get started"}
          </div>
        </div>
        <button onClick={() => { if (month === 11) { setMonth(0); setYear(y => y+1); } else setMonth(m=>m+1); }}
          style={{ background: "#f1f5f9", border: "none", color: "#475569", borderRadius: 10, width: 34, height: 34, cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>›</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 3, textAlign: "center" }}>
        {["日","一","二","三","四","五","六"].map(d => (
          <div key={d} style={{ color: "#94a3b8", fontSize: 11, paddingBottom: 6, fontWeight: 600 }}>{d}</div>
        ))}
        {cells.map((d, i) => {
          if (!d) return <div key={i} />;
          const k = keyFor(d);
          const dd = data[k] || {};
          const hasGym = dd.gymDone;
          const isToday = k === todayKey();
          const isSel = k === selected;
          return (
            <div key={k} onClick={() => onSelect(k)}
              style={{
                borderRadius: 10, padding: "7px 2px", cursor: "pointer",
                background: isSel ? "linear-gradient(135deg, #2563eb, #3b82f6)" : hasGym ? "#eff6ff" : isToday ? "#f8fafc" : "transparent",
                color: isSel ? "#fff" : hasGym ? "#2563eb" : isToday ? "#2563eb" : "#475569",
                fontWeight: isToday || isSel || hasGym ? 700 : 400, fontSize: 13,
                boxShadow: isSel ? "0 2px 8px rgba(37,99,235,0.3)" : "none",
                transition: "all 0.15s",
              }}>
              {d}
              {hasGym && !isSel && (
                <div style={{ display: "flex", justifyContent: "center", marginTop: 3 }}>
                  <div style={{ width: 4, height: 4, borderRadius: "50%", background: "#2563eb" }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Gym Logger ────────────────────────────────────────────────────────────────
function GymLogger({ dayData, onUpdate, selectedDay }) {
  const [group, setGroup] = useState(MUSCLE_GROUPS[0]);
  const [exercise, setExercise] = useState("");
  const [sets, setSets] = useState([{ reps: "", weight: "" }]);
  const [editIdx, setEditIdx] = useState(null);

  const addSet = () => setSets(s => [...s, { reps: "", weight: "" }]);
  const removeSet = (i) => setSets(s => s.filter((_, idx) => idx !== i));
  const updateSet = (i, field, val) => setSets(s => s.map((row, idx) => idx === i ? { ...row, [field]: val } : row));

  const startEdit = (i) => {
    const e = dayData.gym[i];
    setGroup(e.group);
    setExercise(e.exercise);
    setSets(e.sets.length > 0 ? e.sets.map(s => ({ reps: s.reps || "", weight: s.weight || "" })) : [{ reps: "", weight: "" }]);
    setEditIdx(i);
  };

  const cancelEdit = () => {
    setEditIdx(null);
    setGroup(MUSCLE_GROUPS[0]);
    setExercise("");
    setSets([{ reps: "", weight: "" }]);
  };

  const doSave = () => {
    if (!exercise.trim()) return;
    const entry = { group, exercise, sets: sets.filter(s => s.reps || s.weight) };
    if (editIdx !== null) {
      const gym = dayData.gym.map((e, i) => i === editIdx ? entry : e);
      onUpdate({ ...dayData, gym });
      setEditIdx(null);
    } else {
      onUpdate({ ...dayData, gymDone: true, gym: [...(dayData.gym || []), entry] });
    }
    setExercise(""); setSets([{ reps: "", weight: "" }]); setGroup(MUSCLE_GROUPS[0]);
  };

  const removeEntry = (i) => {
    const gym = dayData.gym.filter((_, idx) => idx !== i);
    onUpdate({ ...dayData, gym, gymDone: gym.length > 0 });
    if (editIdx === i) cancelEdit();
  };

  return (
    <div>
      <div style={{ margin: "16px 0 10px" }}>
        <span style={{ fontSize: 18, fontWeight: 800, color: "#1e293b" }}>{formatDate(selectedDay)}</span>
        {dayData.gym?.length > 0 && <span style={{ fontSize: 13, color: "#94a3b8", marginLeft: 8 }}>{dayData.gym.length} exercises</span>}
      </div>

      {dayData.gym?.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          {dayData.gym.map((e, i) => (
            <div key={i} className="card-flat">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <span style={{ background: "linear-gradient(135deg, #2563eb, #3b82f6)", color: "#fff", borderRadius: 6, padding: "2px 9px", fontSize: 11, fontWeight: 700, marginRight: 8 }}>{e.group}</span>
                  <span style={{ color: "#1e293b", fontWeight: 600 }}>{e.exercise}</span>
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  <button onClick={() => startEdit(i)} style={{ ...delBtn, color: "#2563eb", fontSize: 13 }}>edit</button>
                  <button onClick={() => removeEntry(i)} style={delBtn}>×</button>
                </div>
              </div>
              <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
                {e.sets.map((s, j) => (
                  <span key={j} style={{ background: "#f1f5f9", borderRadius: 8, padding: "4px 10px", fontSize: 12, color: "#475569", fontWeight: 500 }}>
                    {j+1}. {s.reps ? `${s.reps}次` : ""}{s.weight ? ` × ${s.weight}kg` : ""}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card" style={editIdx !== null ? { borderLeft: "3px solid #f59e0b" } : {}}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="section-title" style={{ marginBottom: 0 }}>{editIdx !== null ? "Edit Exercise" : "Add Exercise"}</div>
          {editIdx !== null && <button onClick={cancelEdit} style={{ background: "#fef2f2", border: "none", borderRadius: 8, padding: "4px 10px", fontSize: 11, color: "#ef4444", fontWeight: 600, cursor: "pointer" }}>Cancel</button>}
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
          {MUSCLE_GROUPS.map(g => (
            <button key={g} onClick={() => setGroup(g)}
              className={`chip ${group === g ? "chip-active" : "chip-inactive"}`}>{g}</button>
          ))}
        </div>
        <input value={exercise} onChange={e => setExercise(e.target.value)} placeholder="动作名称（如：卧推）" className="input" />
        <div style={{ marginTop: 10 }}>
          {sets.map((s, i) => (
            <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
              <span style={{ color: "#94a3b8", fontSize: 12, width: 28, fontWeight: 600 }}>#{i+1}</span>
              <input value={s.reps} onChange={e => updateSet(i, "reps", e.target.value)}
                placeholder="次数" type="number" className="input" style={{ flex: 1, marginBottom: 0 }} />
              <input value={s.weight} onChange={e => updateSet(i, "weight", e.target.value)}
                placeholder="kg" type="number" className="input" style={{ flex: 1, marginBottom: 0 }} />
              {sets.length > 1 && <button onClick={() => removeSet(i)} style={delBtn}>×</button>}
            </div>
          ))}
          <button onClick={addSet} className="chip chip-inactive" style={{ marginTop: 4 }}>+ 加一组</button>
        </div>
        <button onClick={doSave} className="btn-primary">{editIdx !== null ? "更新动作" : "保存动作"}</button>
      </div>
    </div>
  );
}

// ── Weekly Menu Modal ─────────────────────────────────────────────────────────
function WeeklyMenuModal({ weekKey, plan, onUpdate, onClose }) {
  const weekEnd = new Date(weekKey);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const endKey = weekEnd.toISOString().slice(0, 10);

  const update = (field, val) => {
    onUpdate(weekKey, { ...plan, [field]: val });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#1e293b" }}>Weekly Menu</div>
            <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 2 }}>{formatDate(weekKey)} — {formatDate(endKey)}</div>
          </div>
          <button onClick={onClose} style={{ background: "#f1f5f9", border: "none", borderRadius: 10, width: 34, height: 34, fontSize: 18, cursor: "pointer", color: "#64748b" }}>×</button>
        </div>

        <div style={{ marginBottom: 20 }}>
          <div className="section-title">Meal Plan</div>
          <textarea value={plan.menu || ""} onChange={e => update("menu", e.target.value)}
            placeholder={"周一：鸡胸肉沙拉 / 三文鱼牛油果饭\n周二：牛肉西兰花 / 虾仁炒蛋\n...随意规划"}
            rows={6} className="input" style={{ resize: "vertical", fontFamily: "inherit", lineHeight: 1.7 }} />
        </div>

        <div style={{ marginBottom: 20 }}>
          <div className="section-title">Grocery List</div>
          <textarea value={plan.groceries || ""} onChange={e => update("groceries", e.target.value)}
            placeholder={"鸡胸肉 1kg\n三文鱼 500g\n西兰花 2颗\n糙米 1袋\n..."}
            rows={5} className="input" style={{ resize: "vertical", fontFamily: "inherit", lineHeight: 1.7 }} />
        </div>

        <div>
          <div className="section-title">Recipe Source</div>
          <input value={plan.source || ""} onChange={e => update("source", e.target.value)}
            placeholder="粘贴链接或备注来源" className="input" />
          {plan.source && plan.source.startsWith("http") && (
            <a href={plan.source} target="_blank" rel="noreferrer"
              style={{ fontSize: 12, color: "#2563eb", fontWeight: 600 }}>打开链接</a>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Date Navigator ───────────────────────────────────────────────────────────
// ── Recipe Library ───────────────────────────────────────────────────────────
const DEFAULT_TAGS = ["肉类", "海鲜", "蔬菜", "主食", "汤", "沙拉", "甜品", "饮品", "酱料"];

function RecipeLibrary({ recipes, addRecipe, updateRecipe, deleteRecipe }) {
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [ingredients, setIngredients] = useState("");
  const [notes, setNotes] = useState("");
  const [source, setSource] = useState("");
  const [selectedTags, setSelectedTags] = useState([]);
  const [customTag, setCustomTag] = useState("");
  const [filterTag, setFilterTag] = useState(null);
  const [editId, setEditId] = useState(null);

  const toggleTag = (tag) => {
    setSelectedTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  };

  const addCustomTag = () => {
    const t = customTag.trim();
    if (t && !selectedTags.includes(t)) {
      setSelectedTags(prev => [...prev, t]);
    }
    setCustomTag("");
  };

  const startEditRecipe = (r) => {
    setEditId(r.id);
    setName(r.name);
    setSelectedTags(r.tags || []);
    setIngredients(r.ingredients || "");
    setNotes(r.notes || "");
    setSource(r.source || "");
    setShowAdd(true);
  };

  const cancelEdit = () => {
    setEditId(null);
    setName(""); setIngredients(""); setNotes(""); setSource(""); setSelectedTags([]);
    setShowAdd(false);
  };

  const doSave = () => {
    if (!name.trim()) return;
    if (editId) {
      updateRecipe(editId, { name, tags: selectedTags, ingredients, notes, source });
      setEditId(null);
    } else {
      addRecipe({ name, tags: selectedTags, ingredients, notes, source });
    }
    setName(""); setIngredients(""); setNotes(""); setSource(""); setSelectedTags([]);
    setShowAdd(false);
  };

  const allTags = [...new Set([...DEFAULT_TAGS, ...recipes.flatMap(r => r.tags || [])])];
  const filtered = filterTag ? recipes.filter(r => (r.tags || []).includes(filterTag)) : recipes;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#1e293b" }}>My Recipes</div>
          <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 2 }}>{recipes.length} dishes saved</div>
        </div>
        <button onClick={() => showAdd ? cancelEdit() : setShowAdd(true)}
          style={{
            border: "none", borderRadius: 12, padding: "10px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer",
            background: showAdd ? "#fee2e2" : "linear-gradient(135deg, #2563eb, #3b82f6)",
            color: showAdd ? "#ef4444" : "#fff",
            boxShadow: showAdd ? "none" : "0 2px 8px rgba(37,99,235,0.25)",
          }}>
          {showAdd ? "取消" : "+ 添加"}
        </button>
      </div>

      {showAdd && (
        <div className="card" style={{ borderLeft: editId ? "3px solid #f59e0b" : "3px solid #2563eb" }}>
          <div className="section-title">{editId ? "Edit Recipe" : "New Recipe"}</div>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="菜名" className="input" />

          <div className="section-title" style={{ marginTop: 4 }}>Tags</div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>
            {allTags.map(tag => (
              <button key={tag} onClick={() => toggleTag(tag)}
                className={`chip ${selectedTags.includes(tag) ? "chip-active" : "chip-inactive"}`}
                style={{ padding: "4px 10px", fontSize: 12 }}>{tag}</button>
            ))}
            {selectedTags.filter(t => !allTags.includes(t)).map(tag => (
              <button key={tag} onClick={() => toggleTag(tag)}
                className="chip chip-active" style={{ padding: "4px 10px", fontSize: 12 }}>{tag}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            <input value={customTag} onChange={e => setCustomTag(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addCustomTag(); } }}
              placeholder="自定义标签" className="input" style={{ flex: 1, marginBottom: 0 }} />
            <button onClick={addCustomTag}
              className="chip chip-inactive" style={{ padding: "6px 14px", fontSize: 12, whiteSpace: "nowrap" }}>+ 添加标签</button>
          </div>

          <textarea value={ingredients} onChange={e => setIngredients(e.target.value)}
            placeholder={"食材清单\n鸡胸肉 200g\n西兰花 100g\n..."}
            rows={3} className="input" style={{ resize: "vertical", fontFamily: "inherit", lineHeight: 1.6 }} />
          <textarea value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="做法备注（可选）"
            rows={2} className="input" style={{ resize: "vertical", fontFamily: "inherit", lineHeight: 1.6 }} />
          <input value={source} onChange={e => setSource(e.target.value)}
            placeholder="食谱来源链接（可选）" className="input" />
          <button onClick={doSave} className="btn-primary">{editId ? "更新菜品" : "保存菜品"}</button>
        </div>
      )}

      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 14 }}>
        <button onClick={() => setFilterTag(null)}
          className={`chip ${filterTag === null ? "chip-active" : "chip-inactive"}`}
          style={{ padding: "4px 12px", fontSize: 12 }}>全部</button>
        {allTags.filter(t => recipes.some(r => (r.tags || []).includes(t))).map(tag => (
          <button key={tag} onClick={() => setFilterTag(filterTag === tag ? null : tag)}
            className={`chip ${filterTag === tag ? "chip-active" : "chip-inactive"}`}
            style={{ padding: "4px 12px", fontSize: 12 }}>{tag}</button>
        ))}
      </div>

      {filtered.length === 0 && (
        <div style={{ textAlign: "center", padding: "40px 0", color: "#94a3b8", fontSize: 14 }}>
          {recipes.length === 0 ? "还没有保存任何菜品" : "该分类下没有菜品"}
        </div>
      )}
      {filtered.map(r => (
        <div key={r.id} className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#1e293b" }}>{r.name}</div>
            <div style={{ display: "flex", gap: 4 }}>
              <button onClick={() => startEditRecipe(r)} style={{ ...delBtn, color: "#2563eb", fontSize: 13 }}>edit</button>
              <button onClick={() => deleteRecipe(r.id)} style={delBtn}>×</button>
            </div>
          </div>
          {(r.tags || []).length > 0 && (
            <div style={{ display: "flex", gap: 4, marginTop: 6, flexWrap: "wrap" }}>
              {r.tags.map(t => (
                <span key={t} style={{ background: "#eff6ff", borderRadius: 6, padding: "2px 8px", fontSize: 11, color: "#2563eb", fontWeight: 600 }}>{t}</span>
              ))}
            </div>
          )}
          {r.ingredients && (
            <div style={{ marginTop: 8, fontSize: 13, color: "#475569", whiteSpace: "pre-line", lineHeight: 1.6, background: "#f8fafc", borderRadius: 8, padding: "8px 10px" }}>
              {r.ingredients}
            </div>
          )}
          {r.notes && <p style={{ marginTop: 6, fontSize: 12, color: "#94a3b8", lineHeight: 1.5 }}>{r.notes}</p>}
          {r.source && r.source.startsWith("http") && (
            <a href={r.source} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#2563eb", fontWeight: 600 }}>食谱来源</a>
          )}
          {r.source && !r.source.startsWith("http") && (
            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>来源: {r.source}</div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Mini Calendar Popup ──────────────────────────────────────────────────────
function CalendarPopup({ onSelect, onClose }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = Array(firstDay).fill(null).concat(Array.from({ length: daysInMonth }, (_, i) => i + 1));
  const pad = (n) => String(n).padStart(2, "0");

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 340, padding: 20 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <button onClick={() => { if (month === 0) { setMonth(11); setYear(y=>y-1); } else setMonth(m=>m-1); }}
            style={{ background: "#f1f5f9", border: "none", color: "#475569", borderRadius: 10, width: 30, height: 30, cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>‹</button>
          <div style={{ fontWeight: 800, color: "#1e293b" }}>{MONTH_NAMES[month]}</div>
          <button onClick={() => { if (month === 11) { setMonth(0); setYear(y=>y+1); } else setMonth(m=>m+1); }}
            style={{ background: "#f1f5f9", border: "none", color: "#475569", borderRadius: 10, width: 30, height: 30, cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>›</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2, textAlign: "center" }}>
          {["日","一","二","三","四","五","六"].map(d => (
            <div key={d} style={{ color: "#94a3b8", fontSize: 10, paddingBottom: 4, fontWeight: 600 }}>{d}</div>
          ))}
          {cells.map((d, i) => {
            if (!d) return <div key={i} />;
            const k = `${year}-${pad(month+1)}-${pad(d)}`;
            const isToday = k === todayKey();
            return (
              <div key={k} onClick={() => { onSelect(k); onClose(); }}
                style={{ borderRadius: 8, padding: "6px 0", cursor: "pointer", fontSize: 13,
                  background: isToday ? "#2563eb" : "transparent", color: isToday ? "#fff" : "#475569",
                  fontWeight: isToday ? 700 : 400 }}>
                {d}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Meal Day Entry (collapsible) ─────────────────────────────────────────────
function MealDayEntry({ dateKey, dayData, isExpanded, onToggle, onRemoveMeal, onEditMeal }) {
  const meals = dayData.meals || [];
  if (meals.length === 0) return null;

  const totals = meals.reduce((acc, m) => {
    const n = m.nutrients || {};
    return {
      calories: acc.calories + (parseFloat(n.calories) || 0),
      protein: acc.protein + (parseFloat(n.protein) || 0),
    };
  }, { calories: 0, protein: 0 });

  return (
    <div className="card" style={{ cursor: "pointer" }} onClick={onToggle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <span style={{ fontSize: 15, fontWeight: 700, color: "#1e293b" }}>{formatDate(dateKey)}</span>
          <span style={{ fontSize: 12, color: "#94a3b8", marginLeft: 8 }}>{meals.length} meals</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {totals.calories > 0 && <span style={nutriTag}>{Math.round(totals.calories)} kcal</span>}
          <span style={{ color: "#94a3b8", fontSize: 14, transition: "transform 0.2s", transform: isExpanded ? "rotate(90deg)" : "none" }}>›</span>
        </div>
      </div>

      {isExpanded && (
        <div style={{ marginTop: 12 }} onClick={e => e.stopPropagation()}>
          {meals.map((m, i) => (
            <div key={i} style={{ background: "#f8fafc", borderRadius: 10, padding: 10, marginBottom: 6, border: "1px solid #eef2f7" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ background: "linear-gradient(135deg, #60a5fa, #93c5fd)", color: "#fff", borderRadius: 6, padding: "2px 8px", fontSize: 10, fontWeight: 700 }}>{m.type}</span>
                  <span style={{ color: "#94a3b8", fontSize: 11 }}>{m.time}</span>
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  <button onClick={() => onEditMeal(dateKey, i)} style={{ ...delBtn, color: "#2563eb", fontSize: 13 }}>edit</button>
                  <button onClick={() => onRemoveMeal(dateKey, i)} style={delBtn}>×</button>
                </div>
              </div>
              {m.photo && <img src={m.photo} alt="" style={{ width: "100%", borderRadius: 8, marginTop: 8, maxHeight: 140, objectFit: "cover" }} />}
              {m.note && <p style={{ color: "#475569", fontSize: 12, marginTop: 6, marginBottom: 0, lineHeight: 1.5 }}>{m.note}</p>}
              {m.nutrients && (m.nutrients.calories || m.nutrients.protein || m.nutrients.carbs || m.nutrients.fat) && (
                <div style={{ display: "flex", gap: 4, marginTop: 6, flexWrap: "wrap" }}>
                  {m.nutrients.calories && <span style={{ ...nutriTag, fontSize: 10 }}>{m.nutrients.calories} kcal</span>}
                  {m.nutrients.protein && <span style={{ ...nutriTag, fontSize: 10 }}>P {m.nutrients.protein}g</span>}
                  {m.nutrients.carbs && <span style={{ ...nutriTag, fontSize: 10 }}>C {m.nutrients.carbs}g</span>}
                  {m.nutrients.fat && <span style={{ ...nutriTag, fontSize: 10 }}>F {m.nutrients.fat}g</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Meal Section ─────────────────────────────────────────────────────────────
function MealSection({ data, plans, updateDay, updatePlan }) {
  const [mealType, setMealType] = useState(MEAL_TYPES[0]);
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState(null);
  const [nutrients, setNutrients] = useState({ calories: "", protein: "", carbs: "", fat: "" });
  const [showPlan, setShowPlan] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [expandedDay, setExpandedDay] = useState(todayKey());
  const [logDate, setLogDate] = useState(todayKey());
  const [editTarget, setEditTarget] = useState(null); // { dateKey, idx }
  const fileRef = useRef();

  const today = todayKey();
  const weekKey = getWeekKey(today);
  const weekPlan = plans[weekKey] || {};
  const hasPlan = weekPlan.menu || weekPlan.groceries;

  // Get all days with meal data, sorted newest first
  const mealDays = Object.keys(data)
    .filter(k => (data[k].meals || []).length > 0)
    .sort((a, b) => b.localeCompare(a));

  // Ensure today is always shown
  const allDays = mealDays.includes(today) ? mealDays : [today, ...mealDays];

  const handlePhoto = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setPhoto(ev.target.result);
    reader.readAsDataURL(file);
  };

  const startEditMeal = (dateKey, idx) => {
    const m = getDayData(data, dateKey).meals[idx];
    setLogDate(dateKey);
    setMealType(m.type);
    setNote(m.note || "");
    setPhoto(m.photo || null);
    setNutrients(m.nutrients || { calories: "", protein: "", carbs: "", fat: "" });
    setEditTarget({ dateKey, idx });
    setExpandedDay(dateKey);
  };

  const cancelEditMeal = () => {
    setEditTarget(null);
    setMealType(MEAL_TYPES[0]);
    setNote(""); setPhoto(null);
    setNutrients({ calories: "", protein: "", carbs: "", fat: "" });
    if (fileRef.current) fileRef.current.value = "";
  };

  const doSave = () => {
    if (!note.trim() && !photo) return;
    const dayData = getDayData(data, logDate);
    const entry = {
      type: mealType, note, photo, nutrients,
      time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
    };
    if (editTarget) {
      // Editing existing meal — preserve original time
      const origMeal = getDayData(data, editTarget.dateKey).meals[editTarget.idx];
      entry.time = origMeal.time || entry.time;
      if (editTarget.dateKey === logDate) {
        const meals = dayData.meals.map((m, i) => i === editTarget.idx ? entry : m);
        updateDay(logDate, { ...dayData, meals });
      } else {
        // Date changed: remove from old day, add to new day
        const oldDayData = getDayData(data, editTarget.dateKey);
        updateDay(editTarget.dateKey, { ...oldDayData, meals: oldDayData.meals.filter((_, i) => i !== editTarget.idx) });
        updateDay(logDate, { ...dayData, meals: [...(dayData.meals || []), entry] });
      }
      setEditTarget(null);
    } else {
      updateDay(logDate, { ...dayData, meals: [...(dayData.meals || []), entry] });
    }
    setNote(""); setPhoto(null);
    setNutrients({ calories: "", protein: "", carbs: "", fat: "" });
    if (fileRef.current) fileRef.current.value = "";
    setExpandedDay(logDate);
  };

  const removeMeal = (dateKey, i) => {
    const dd = getDayData(data, dateKey);
    updateDay(dateKey, { ...dd, meals: dd.meals.filter((_, idx) => idx !== i) });
    if (editTarget && editTarget.dateKey === dateKey && editTarget.idx === i) cancelEditMeal();
  };

  const pickDate = (dateKey) => {
    setLogDate(dateKey);
    setExpandedDay(dateKey);
    setShowCalendar(false);
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: "#1e293b" }}>Meals</div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setShowCalendar(true)}
            style={{ background: "#f1f5f9", border: "none", borderRadius: 10, width: 34, height: 34, cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", color: "#475569" }}>
            &#x1F4C5;
          </button>
          <button onClick={() => setShowPlan(true)}
            style={{
              border: "none", borderRadius: 12, padding: "8px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer",
              background: hasPlan ? "linear-gradient(135deg, #dbeafe, #eff6ff)" : "#f1f5f9",
              color: hasPlan ? "#2563eb" : "#64748b",
            }}>
            {hasPlan ? "Weekly Menu" : "+ Weekly Menu"}
          </button>
        </div>
      </div>

      {/* Weekly plan preview */}
      {hasPlan && weekPlan.menu && (
        <div onClick={() => setShowPlan(true)} className="card" style={{ cursor: "pointer", borderLeft: "3px solid #2563eb" }}>
          <div className="section-title" style={{ marginBottom: 6 }}>Weekly Menu</div>
          <div style={{ fontSize: 13, color: "#475569", whiteSpace: "pre-line", lineHeight: 1.7, maxHeight: 56, overflow: "hidden" }}>{weekPlan.menu}</div>
          <div style={{ fontSize: 12, color: "#2563eb", marginTop: 6, fontWeight: 600 }}>View full plan</div>
        </div>
      )}

      {/* Add/Edit meal form */}
      <div className="card" style={{ borderLeft: editTarget ? "3px solid #f59e0b" : "3px solid #60a5fa" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div className="section-title" style={{ marginBottom: 0 }}>{editTarget ? "Edit Meal" : "Log a Meal"} — {formatDate(logDate)}</div>
          <div style={{ display: "flex", gap: 6 }}>
            {logDate !== today && !editTarget && (
              <button onClick={() => setLogDate(today)}
                style={{ background: "#f1f5f9", border: "none", borderRadius: 8, padding: "4px 10px", fontSize: 11, color: "#2563eb", fontWeight: 600, cursor: "pointer" }}>
                Back to Today
              </button>
            )}
            {editTarget && (
              <button onClick={cancelEditMeal}
                style={{ background: "#fef2f2", border: "none", borderRadius: 8, padding: "4px 10px", fontSize: 11, color: "#ef4444", fontWeight: 600, cursor: "pointer" }}>
                Cancel
              </button>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          {MEAL_TYPES.map(t => (
            <button key={t} onClick={() => setMealType(t)}
              className={`chip ${mealType === t ? "chip-active-light" : "chip-inactive"}`}>{t}</button>
          ))}
        </div>

        {photo && (
          <div style={{ position: "relative", marginBottom: 10 }}>
            <img src={photo} alt="" style={{ width: "100%", borderRadius: 10, maxHeight: 160, objectFit: "cover" }} />
            <button onClick={() => setPhoto(null)}
              style={{ position: "absolute", top: 8, right: 8, background: "rgba(0,0,0,0.5)", border: "none", color: "#fff", borderRadius: "50%", width: 26, height: 26, cursor: "pointer", fontSize: 14, backdropFilter: "blur(4px)" }}>×</button>
          </div>
        )}

        <button onClick={() => fileRef.current?.click()}
          style={{ width: "100%", padding: "12px 0", background: "#f1f5f9", border: "1.5px dashed #cbd5e1", borderRadius: 12, color: "#64748b", fontSize: 13, fontWeight: 600, cursor: "pointer", marginBottom: 10 }}>
          拍照 / 选图
        </button>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={handlePhoto} style={{ display: "none" }} />

        <textarea value={note} onChange={e => setNote(e.target.value)}
          placeholder="食物描述（如：鸡胸肉200g + 糙米150g）"
          rows={2} className="input" style={{ resize: "none", fontFamily: "inherit" }} />

        <div className="section-title" style={{ marginTop: 6, marginBottom: 8 }}>Nutrients</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <input value={nutrients.calories} onChange={e => setNutrients(n => ({ ...n, calories: e.target.value }))}
            placeholder="Calories (kcal)" type="number" className="input" style={{ marginBottom: 0 }} />
          <input value={nutrients.protein} onChange={e => setNutrients(n => ({ ...n, protein: e.target.value }))}
            placeholder="Protein (g)" type="number" className="input" style={{ marginBottom: 0 }} />
          <input value={nutrients.carbs} onChange={e => setNutrients(n => ({ ...n, carbs: e.target.value }))}
            placeholder="Carbs (g)" type="number" className="input" style={{ marginBottom: 0 }} />
          <input value={nutrients.fat} onChange={e => setNutrients(n => ({ ...n, fat: e.target.value }))}
            placeholder="Fat (g)" type="number" className="input" style={{ marginBottom: 0 }} />
        </div>

        <button onClick={doSave} className="btn-secondary">{editTarget ? "更新饮食" : "记录饮食"}</button>
      </div>

      {/* Diary-style timeline */}
      <div className="section-title" style={{ marginTop: 8 }}>History</div>
      {allDays.map(dateKey => (
        <MealDayEntry
          key={dateKey}
          dateKey={dateKey}
          dayData={getDayData(data, dateKey)}
          isExpanded={expandedDay === dateKey}
          onToggle={() => setExpandedDay(expandedDay === dateKey ? null : dateKey)}
          onRemoveMeal={removeMeal}
          onEditMeal={startEditMeal}
        />
      ))}
      {allDays.length <= 1 && !getDayData(data, today).meals?.length && (
        <div style={{ textAlign: "center", padding: "30px 0", color: "#94a3b8", fontSize: 13 }}>还没有饮食记录</div>
      )}

      {showPlan && <WeeklyMenuModal weekKey={weekKey} plan={weekPlan} onUpdate={updatePlan} onClose={() => setShowPlan(false)} />}
      {showCalendar && <CalendarPopup onSelect={pickDate} onClose={() => setShowCalendar(false)} />}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const { user, loading: authLoading } = useAuth();

  if (authLoading) {
    return (
      <div className="app-root" style={{ display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Inter', 'PingFang SC', -apple-system, sans-serif" }}>
        <InjectCSS />
        <div style={{ color: "#94a3b8", fontSize: 14 }}>Loading...</div>
      </div>
    );
  }

  if (!user) return <AuthScreen />;

  return <MainApp user={user} />;
}

function MainApp({ user }) {
  const { data, plans, loaded, updateDay, updatePlan } = useCloudData(user);
  const { recipes, loaded: recipesLoaded, addRecipe, updateRecipe, deleteRecipe } = useRecipes(user);
  const [selectedDay, setSelectedDay] = useState(todayKey());
  const [tab, setTab] = useState("gym");

  const dayData = getDayData(data, selectedDay);

  const handleUpdateDay = (newDayData) => {
    updateDay(selectedDay, newDayData);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  if (!loaded || !recipesLoaded) {
    return (
      <div className="app-root" style={{ display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Inter', 'PingFang SC', -apple-system, sans-serif" }}>
        <InjectCSS />
        <div style={{ color: "#94a3b8", fontSize: 14 }}>Syncing...</div>
      </div>
    );
  }

  return (
    <div className="app-root" style={{ color: "#1e293b", fontFamily: "'Inter', 'PingFang SC', 'Hiragino Sans GB', -apple-system, sans-serif", maxWidth: 420, margin: "0 auto", padding: "0 0 40px" }}>
      <InjectCSS />

      <div style={{ padding: "16px 16px 0" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: "#94a3b8" }}>{user.email}</div>
          <button onClick={handleLogout}
            style={{ background: "none", border: "none", color: "#94a3b8", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
            退出
          </button>
        </div>

        <div className="tab-bar">
          <button onClick={() => setTab("gym")} className={`tab-btn ${tab === "gym" ? "active" : ""}`}>健身</button>
          <button onClick={() => setTab("meal")} className={`tab-btn ${tab === "meal" ? "active" : ""}`}>饮食</button>
          <button onClick={() => setTab("recipes")} className={`tab-btn ${tab === "recipes" ? "active" : ""}`}>菜单库</button>
        </div>

        <div className="main-layout">
          {tab === "gym" ? (
            <div>
              <GymCalendar data={data} selected={selectedDay} onSelect={setSelectedDay} />
              <GymLogger dayData={dayData} onUpdate={handleUpdateDay} selectedDay={selectedDay} />
            </div>
          ) : tab === "meal" ? (
            <MealSection data={data} plans={plans} updateDay={updateDay} updatePlan={updatePlan} />
          ) : (
            <RecipeLibrary recipes={recipes} addRecipe={addRecipe} updateRecipe={updateRecipe} deleteRecipe={deleteRecipe} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Shared inline styles ─────────────────────────────────────────────────────
const delBtn = {
  background: "none", border: "none", color: "#cbd5e1", cursor: "pointer", fontSize: 18,
  transition: "color 0.15s",
};
const nutriTag = {
  background: "#eff6ff", borderRadius: 8, padding: "3px 10px", fontSize: 11, color: "#2563eb", fontWeight: 600
};
