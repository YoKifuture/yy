import com.comsol.model.Model;
import com.comsol.model.util.ModelUtil;
import java.util.Properties;

public class HoodAcoustics {
    private static final String COMP = "comp1";
    private static final String GEOM = "geom1";
    private static final String PHYSICS = "acpr";
    private static final String JOB_DIRECTORY = "__COMSOL_JOB_DIRECTORY__";

    private static double readNumber(Properties settings, String name, double fallback) {
        double value = Double.parseDouble(settings.getProperty(name, Double.toString(fallback)));
        if (!Double.isFinite(value) || value <= 0) throw new IllegalArgumentException(name);
        return value;
    }

    private static void rectangle(Model model, String tag, String width, String height, String x, String y) {
        var geom = model.component(COMP).geom(GEOM);
        var rectangle = geom.create(tag, "Rectangle");
        rectangle.set("size", new String[]{width, height});
        rectangle.set("pos", new String[]{x, y});
    }

    private static void selectEnd(Model model, String tag, String x) {
        var box = model.component(COMP).selection().create(tag, "Box");
        box.geom(GEOM, 1);
        box.set("condition", "inside");
        box.set("xmin", x + "-0.00001[m]");
        box.set("xmax", x + "+0.00001[m]");
        if (box.entities(1).length != 1) throw new IllegalStateException("Expected one boundary at " + tag);
    }

    private static Model build(boolean branch, Properties settings) {
        Model model = ModelUtil.create(branch ? "Resonator" : "Reference");
        model.label(branch ? "Side-branch Helmholtz.mph" : "Straight duct reference.mph");
        model.param().set("ductL", readNumber(settings, "length", 360) + "[mm]");
        model.param().set("ductH", readNumber(settings, "duct", 65) + "[mm]");
        model.param().set("neckW", readNumber(settings, "neck", 12) + "[mm]");
        model.param().set("neckH", readNumber(settings, "neckLength", 20) + "[mm]");
        model.param().set("cavityW", readNumber(settings, "cavityLength", 97) + "[mm]");
        model.param().set("cavityH", readNumber(settings, "cavityHeight", 70) + "[mm]");
        model.param().set("airRho", "1.204[kg/m^3]");
        model.param().set("airC", "343[m/s]");
        model.component().create(COMP, true);
        var component = model.component(COMP);
        var geom = component.geom().create(GEOM, 2);
        geom.lengthUnit("m");
        rectangle(model, "duct", "ductL", "ductH", "0", "0");
        if (branch) {
            rectangle(model, "neck", "neckW", "neckH", "(ductL-neckW)/2", "ductH");
            rectangle(model, "cavity", "cavityW", "cavityH", "(ductL-cavityW)/2", "ductH+neckH");
        }
        geom.run();
        selectEnd(model, "inlet", "0[m]");
        selectEnd(model, "outlet", "ductL");

        var air = component.material().create("air", "Common");
        air.label("Air at 20 C, no mean flow");
        air.propertyGroup("def").set("density", "airRho");
        air.propertyGroup("def").set("soundspeed", "airC");
        var physics = component.physics().create(PHYSICS, "PressureAcoustics", GEOM);
        for (int index = 1; index <= 2; index++) {
            var port = physics.create("port" + index, "Port", 1);
            port.selection().named(index == 1 ? "inlet" : "outlet");
            port.set("PortType", "Slit");
            port.set("m_slit", "0");
            port.set("PortExcitation", index == 1 ? "on" : "off");
            if (index == 1) port.set("pamp", "1[Pa]");
        }
        var mesh = component.mesh().create("mesh1");
        mesh.create("ftri1", "FreeTri");
        mesh.feature("size").set("custom", "on");
        double start = readNumber(settings, "start", 150);
        double stop = readNumber(settings, "stop", 950);
        double step = readNumber(settings, "step", 5);
        mesh.feature("size").set("hmax", Math.min(0.006, 343.0 / (8 * stop)) + "[m]");
        mesh.feature("size").set("hmin", "0.0015[m]");
        mesh.run();
        var study = model.study().create("std1");
        study.create("freq", "Frequency");
        study.feature("freq").set("plist", "range(" + start + "," + step + "," + stop + ")");
        study.run();
        return model;
    }

    private static Model buildAbsorber(Properties settings, int mode) {
        Model model = ModelUtil.create("Absorber");
        model.label(mode == 1 ? "Microperforated panel - normal incidence.mph" : "Porous absorber - normal incidence.mph");
        model.param().set("tubeL", "100[mm]");
        model.param().set("airRho", "1.204[kg/m^3]");
        model.param().set("airC", "343[m/s]");
        var c = model.component().create(COMP, true);
        var geometry = c.geom().create(GEOM, 2);
        geometry.lengthUnit("m");
        rectangle(model, "tube", "tubeL", "20[mm]", "0", "0");
        geometry.run();
        selectEnd(model, "inlet", "0[m]");
        selectEnd(model, "absorber", "tubeL");
        var air = c.material().create("air", "Common");
        air.propertyGroup("def").set("density", "airRho");
        air.propertyGroup("def").set("soundspeed", "airC");
        var physics = c.physics().create(PHYSICS, "PressureAcoustics", GEOM);
        var port = physics.create("port1", "Port", 1);
        port.selection().named("inlet");
        port.set("PortType", "Slit");
        port.set("PortExcitation", "on");
        port.set("pamp", "1[Pa]");
        var impedance = physics.create("imp1", "Impedance", 1);
        impedance.selection().named("absorber");
        if (mode == 1) {
            model.param().set("holeD", readNumber(settings, "hole", 0.5) + "[mm]");
            model.param().set("plateT", readNumber(settings, "plate", 1) + "[mm]");
            model.param().set("backD", readNumber(settings, "depth", 12) + "[mm]");
            model.param().set("porRatio", readNumber(settings, "ratio", 0.006));
            model.param().set("airMu", "1.825e-5[Pa*s]");
            var v = c.variable().create("mpp");
            v.set("omegaMpp", "2*pi*freq");
            v.set("shearMpp", "holeD*sqrt(omegaMpp*airRho/(4*airMu))");
            v.set("rMpp", "32*airMu*plateT/(porRatio*airRho*airC*holeD^2)*(sqrt(1+shearMpp^2/32)+sqrt(2)*shearMpp*holeD/(32*plateT))");
            v.set("xMpp", "omegaMpp*plateT/(porRatio*airC)*(1+1/sqrt(9+shearMpp^2/2)+0.85*holeD/plateT)-cot(omegaMpp*backD/airC)");
            impedance.set("Zn", "airRho*airC*(rMpp+i*xMpp)");
        } else {
            impedance.set("ImpedanceModel", "PorousModel");
            impedance.set("Constants", mode == 2 ? "Miki" : "DelanyBazley");
            impedance.set("thickness", readNumber(settings, "thickness", 13) + "[mm]");
            impedance.set("Rf_mat", "userdef");
            impedance.set("Rf", readNumber(settings, "resistivity", 20000) + "[Pa*s/m^2]");
            impedance.set("rhof_mat", "userdef");
            impedance.set("rhof", "airRho");
            impedance.set("c_mat", "userdef");
            impedance.set("c", "airC");
        }
        var mesh = c.mesh().create("mesh1");
        mesh.create("ftri1", "FreeTri");
        mesh.feature("size").set("custom", "on");
        mesh.feature("size").set("hmax", "0.004[m]");
        mesh.run();
        double start = readNumber(settings, "start", 600);
        double stop = readNumber(settings, "stop", 1200);
        double step = readNumber(settings, "step", 15);
        var study = model.study().create("std1");
        study.create("freq", "Frequency");
        study.feature("freq").set("plist", "range(" + start + "," + step + "," + stop + ")");
        study.run();
        return model;
    }

    private static void writeResults(Model model, String output, String metric) {
        var evaluation = model.result().numerical().create("globalTL", "EvalGlobal");
        evaluation.set("data", "dset1");
        evaluation.set("expr", new String[]{"freq", metric});
        double[][] rows = evaluation.getReal();
        if (rows.length != 2 || rows[0].length < 3 || rows[0].length != rows[1].length) {
            throw new IllegalStateException("Frequency sweep export has unexpected dimensions");
        }
        for (int i = 0; i < rows[0].length; i++) {
            if (!Double.isFinite(rows[0][i]) || !Double.isFinite(rows[1][i])) {
                throw new IllegalStateException("The computed sweep contains a non-finite value");
            }
        }
        var table = model.result().table().create("tblTL", "Table");
        evaluation.set("table", "tblTL");
        evaluation.setResult();
        table.save(output);
    }

    public static void main(String[] args) throws java.io.IOException {
        Properties settings = new Properties();
        // __COMSOL_JOB_SETTINGS__
        if (settings.containsKey("mode")) {
            int mode = (int) readNumber(settings, "mode", 1);
            if (mode > 3) throw new IllegalArgumentException("absorption mode");
            Model model = buildAbsorber(settings, mode);
            writeResults(model, JOB_DIRECTORY + "/absorber.csv", "1-abs(acpr.S11)^2");
            model.save(JOB_DIRECTORY + "/absorber.mph");
            ModelUtil.remove(model.tag());
            return;
        }
        for (boolean branch : new boolean[]{false, true}) {
            String name = branch ? "side-branch" : "reference";
            Model model = build(branch, settings);
            writeResults(model, JOB_DIRECTORY + "/" + name + ".csv", "10*log10(acpr.port1.P_in/acpr.port2.P_out)");
            model.save(JOB_DIRECTORY + "/" + name + ".mph");
            ModelUtil.remove(model.tag());
        }
    }
}
